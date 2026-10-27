// =========================================================================
// SecureConnect — Gemini Voice Assistant + ESP8266 Hardware Control
// =========================================================================

// Enter your Gemini API key in Settings.
// Do not hard-code or share API keys.
const DEFAULT_GEMINI_KEY = "AQ.Ab8RN6KgEYTwz8buVFRGduqol6MyQl_AW9O5rbsxFKE5e091Eg";
const DEFAULT_MODEL = "gemini-3.5-flash-light(fastest)";
const GEMINI_REST_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

const $ = (id) => document.getElementById(id);

// =========================================================================
// Application Configuration
// =========================================================================

const config = {
  apiKey: localStorage.getItem("sc_gemini_key") || DEFAULT_GEMINI_KEY,
  model: localStorage.getItem("sc_gemini_model") || DEFAULT_MODEL,
  lang: localStorage.getItem("sc_speech_lang") || "hi-IN",
  ttsEnabled: localStorage.getItem("sc_tts_enabled") !== "false",
};

const state = {
  doorLocked: true,
  bedroom: false,
  hall: false,
  fan: false,
  history: [],
};

// =========================================================================
// Speech Recognition
// =========================================================================

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let isListening = false;
let lastAssistantSpeech = "";

// =========================================================================
// Status and UI Rendering
// =========================================================================

function setStatus(text) {
  $("voiceStatus").textContent = text;
}

function setInterpretation(text, source = "Gemini") {
  $("interpretation").textContent = text;
  lastAssistantSpeech = text;

  const badge = $("sourceBadge");
  badge.textContent = source;
  badge.className =
    "source-badge " +
    (source.toLowerCase().includes("fallback") ? "fallback" : "");
}

function renderDevices() {
  // Main Door
  $("doorState").textContent = state.doorLocked
    ? "Locked · hardware"
    : "Unlocked · hardware";

  $("doorBadge").textContent = state.doorLocked ? "LOCKED" : "UNLOCKED";
  $("doorBadge").className =
    "state-badge " + (state.doorLocked ? "" : "unlocked");

  $("cardDoor").classList.toggle("active-state", !state.doorLocked);

  // Bedroom Light
  $("bedroomToggle").checked = state.bedroom;
  $("bedroomState").textContent = state.bedroom
    ? "On · hardware"
    : "Off · hardware";

  $("bedroomGlow").classList.toggle("on", state.bedroom);
  $("cardBedroom").classList.toggle("active-state", state.bedroom);

  // Hall Light
  $("hallToggle").checked = state.hall;
  $("hallState").textContent = state.hall
    ? "On · hardware"
    : "Off · hardware";

  $("hallGlow").classList.toggle("on", state.hall);
  $("cardHall").classList.toggle("active-state", state.hall);

  // Ceiling Fan
  $("fanToggle").checked = state.fan;
  $("fanState").textContent = state.fan
    ? "On · hardware"
    : "Off · hardware";

  $("fanArt").classList.toggle("spinning", state.fan);
  $("cardFan").classList.toggle("active-state", state.fan);
}

// =========================================================================
// Conversation History
// =========================================================================

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function appendHistory(userText, assistantText, source) {
  state.history.unshift({
    q: userText,
    a: assistantText,
    source,
  });

  if (state.history.length > 20) {
    state.history.pop();
  }

  const container = $("historyList");
  if (!container) return;

  if (state.history.length === 0) {
    container.innerHTML =
      '<p class="history-empty">No commands yet. Speak or type above to start.</p>';
    return;
  }

  container.innerHTML = state.history
    .map(
      (item) => `
      <div class="history-item">
        <div class="history-q">
          🗣️ “${escapeHtml(item.q)}”
        </div>
        <div class="history-a">
          🤖 ${escapeHtml(item.a)}
          <small>(${escapeHtml(item.source)})</small>
        </div>
      </div>
    `
    )
    .join("");
}

// =========================================================================
// ESP8266 Connection
// =========================================================================

// ESP8266 access point address.
// Your phone must be connected to ESP8266_Test Wi-Fi.
const ESP8266_IP = "http://192.168.137.200";

async function sendESPCommand(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${ESP8266_IP}${path}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ESP8266 HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "ESP8266 request timed out. Check Wi-Fi and ESP8266 power."
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// =========================================================================
// Physical Device Actions
// =========================================================================

async function performAction(action) {
  const commands = {
    lock_door: [
      ["/door?action=lock", "doorLocked", true],
    ],

    unlock_door: [
      ["/door?action=unlock", "doorLocked", false],
    ],

    bedroom_light_on: [
      ["/device?device=bedroomLight&action=on", "bedroom", true],
    ],

    bedroom_light_off: [
      ["/device?device=bedroomLight&action=off", "bedroom", false],
    ],

    hall_light_on: [
      ["/device?device=hallLight&action=on", "hall", true],
    ],

    hall_light_off: [
      ["/device?device=hallLight&action=off", "hall", false],
    ],

    fan_on: [
      ["/device?device=fan&action=on", "fan", true],
    ],

    fan_off: [
      ["/device?device=fan&action=off", "fan", false],
    ],

    // All devices ON:
    // Unlock the door and turn on both lights and the fan.
    all_devices_on: [
      ["/door?action=unlock", "doorLocked", false],
      ["/device?device=bedroomLight&action=on", "bedroom", true],
      ["/device?device=hallLight&action=on", "hall", true],
      ["/device?device=fan&action=on", "fan", true],
    ],

    // All devices OFF:
    // Lock the door and turn off both lights and the fan.
    all_devices_off: [
      ["/door?action=lock", "doorLocked", true],
      ["/device?device=bedroomLight&action=off", "bedroom", false],
      ["/device?device=hallLight&action=off", "hall", false],
      ["/device?device=fan&action=off", "fan", false],
    ],
  };

  const selectedCommands = commands[action];

  if (!selectedCommands) {
    return false;
  }

  // Execute commands one by one.
  // Update the UI only after each successful response.
  for (const [path, stateKey, value] of selectedCommands) {
    await sendESPCommand(path);
    state[stateKey] = value;
    renderDevices();
  }

  return true;
}

// =========================================================================
// Read Actual ESP8266 Status
// =========================================================================

async function refreshHardwareStatus() {
  try {
    const data = await sendESPCommand("/status");

    if (typeof data.locked === "boolean") {
      state.doorLocked = data.locked;
    }

    if (typeof data.bedroomLight === "boolean") {
      state.bedroom = data.bedroomLight;
    }

    if (typeof data.hallLight === "boolean") {
      state.hall = data.hallLight;
    }

    if (typeof data.fan === "boolean") {
      state.fan = data.fan;
    }

    renderDevices();
    setStatus("Connected to ESP8266 hardware.");
  } catch (error) {
    console.warn("Could not read ESP8266 status:", error);

    setStatus(
      "Server not reachable. Connect to Hotspot and retry."
    );
  }
}

// =========================================================================
// Text-to-Speech
// =========================================================================

function speakText(text) {
  if (
    !config.ttsEnabled ||
    !window.speechSynthesis ||
    !text
  ) {
    return;
  }

  try {
    window.speechSynthesis.cancel();

    const cleanText = text.replace(/\[.*?\]/g, "").trim();
    const utterance = new SpeechSynthesisUtterance(cleanText);

    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();

    if (voices.length > 0) {
      const match = voices.find(
        (voice) =>
          voice.lang.startsWith("hi") ||
          voice.lang.startsWith("en-IN")
      );

      if (match) {
        utterance.voice = match;
      }
    }

    window.speechSynthesis.speak(utterance);
  } catch (error) {
    console.warn("Text-to-speech error:", error);
  }
}

// =========================================================================
// Local Command Interpretation
// Used when Gemini is unavailable
// =========================================================================

function normalize(text) {
  return text
    .toLocaleLowerCase("en-IN")
    .replace(/[.,!?;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localInterpret(text) {
  const t = normalize(text);
  const has = (regex) => regex.test(t);

  // Device detection
  const fan = has(/\b(fan|pankha|पंखा)\b/);

  const door = has(
    /\b(door|darwaza|darwaje|gate)\b|दरवाजा|दरवाज़ा|गेट/
  );

  const light = has(
    /\b(light|lights|bulb)\b|लाइट|बत्ती/
  );

  const bedroom = has(
    /\b(bedroom|bed room|kamra)\b|कमरे|बेडरूम|कमरा/
  );

  const hall = has(
    /\b(hall|living room|lounge)\b|हॉल/
  );

  // ON / OFF intent
  const on =
    has(/\b(on|start|chalu|chaalu|shuru|jalao|khol|kholo|open|unlock)\b/) ||
    /चालू|शुरू|जलाओ|खोलो|खोल दो/.test(t);

  const off =
    has(/\b(off|stop|band|bandh|bujhao|close|lock)\b/) ||
    /बंद|बन्द|बुझाओ/.test(t);

  // All-device command detection.
  // Supports English, Hinglish and common Hindi phrases.
  const allDevices =
    has(
      /\b(all|everything|devices|device|sab|saare|sare|sabhi|poore|sabkuch|sab kuch)\b/
    ) ||
    /सभी|सारे|सब|सबकुछ|सब कुछ|सारे डिवाइस|सभी डिवाइस|सब चालू|सब बंद/.test(t);

  const wantsOn =
    has(/\b(on|start|chalu|chaalu|shuru|jalao|jala do)\b/) ||
    /चालू|शुरू|जलाओ|जला दो/.test(t);

  const wantsOff =
    has(/\b(off|stop|band|bandh|bujhao|bujha do)\b/) ||
    /बंद|बन्द|बुझाओ/.test(t);

  // All devices ON
  if (allDevices && wantsOn) {
    return {
      type: "device_action",
      action: "all_devices_on",
      response:
        "Okay, unlocking the door and turning on both lights and the fan.",
    };
  }

  // All devices OFF
  if (allDevices && wantsOff) {
    return {
      type: "device_action",
      action: "all_devices_off",
      response:
        "Okay, locking the door and turning off both lights and the fan.",
    };
  }

  // Fan commands
  if (fan && off) {
    return {
      type: "device_action",
      action: "fan_off",
      response: "Okay, turning the fan off.",
    };
  }

  if (fan && on) {
    return {
      type: "device_action",
      action: "fan_on",
      response: "Okay, turning the fan on.",
    };
  }

  // Door commands
  if (
    door &&
    (has(/\b(unlock|open|kholo|khol do)\b/) ||
      /खोलो|खोल दो|खोलना/.test(t))
  ) {
    return {
      type: "device_action",
      action: "unlock_door",
      response: "Okay, unlocking the main door.",
    };
  }

  if (
    door &&
    (has(/\b(lock|close|band|bandh)\b/) ||
      /बंद|बन्द|लगाओ/.test(t))
  ) {
    return {
      type: "device_action",
      action: "lock_door",
      response: "Okay, locking the main door.",
    };
  }

  // Bedroom light commands
  if (light && bedroom && off) {
    return {
      type: "device_action",
      action: "bedroom_light_off",
      response: "Okay, turning off the bedroom light.",
    };
  }

  if (light && bedroom && on) {
    return {
      type: "device_action",
      action: "bedroom_light_on",
      response: "Okay, turning on the bedroom light.",
    };
  }

  // Hall light commands
  if (light && hall && off) {
    return {
      type: "device_action",
      action: "hall_light_off",
      response: "Okay, turning off the hall light.",
    };
  }

  if (light && hall && on) {
    return {
      type: "device_action",
      action: "hall_light_on",
      response: "Okay, turning on the hall light.",
    };
  }

  // If the user mentions only "light", ask which light.
  if (light && !bedroom && !hall) {
    return {
      type: "clarification",
      action: "none",
      response:
        "Would you like to change the bedroom light or the hall light?",
    };
  }

  // Help commands
  if (has(/\b(what can you do|help|madad|features)\b/)) {
    return {
      type: "conversation",
      action: "none",
      response:
        "I can control your door, ceiling fan, bedroom light, and hall light in Hindi, English, or Hinglish.",
    };
  }

  // Unknown command
  return {
    type: "conversation",
    action: "none",
    response:
      "I didn't quite catch that. Try saying fan chalu karo, darwaza kholo, or saare device on kar do.",
  };
}

// =========================================================================
// Direct Gemini API
// =========================================================================

async function callGemini(userText) {
  const apiKey = config.apiKey.trim();

  if (!apiKey) {
    throw new Error(
      "No AI API key provided. Please configure your key in Settings."
    );
  }

  const systemInstruction = `
You are SecureConnect, a smart home voice assistant.

The user may speak in English, Hindi, or Hinglish.
Understand natural speech, spelling variations, and speech-recognition errors.

Possible request types:
- device_action
- conversation
- clarification

Supported actions:
- lock_door
- unlock_door
- bedroom_light_on
- bedroom_light_off
- hall_light_on
- hall_light_off
- fan_on
- fan_off
- all_devices_on
- all_devices_off
- none

IMPORTANT ALL-DEVICE RULES:

1. If the user says "saare device on kar do",
"sare devices on", "sab chalu kar do", "sab kuch chalu kar do",
"saari lights aur fan chala do", "turn everything on",
"turn all devices on", or a similar phrase,
return action "all_devices_on".

2. all_devices_on means:
- Unlock the main door.
- Turn on the bedroom light.
- Turn on the hall light.
- Turn on the fan.

3. If the user says "saare device band kar do",
"sab band kar do", "sab kuch band kar do",
"turn everything off", or a similar phrase,
return action "all_devices_off".

4. all_devices_off means:
- Lock the main door.
- Turn off the bedroom light.
- Turn off the hall light.
- Turn off the fan.

5. Other examples:
- "darwaza kholo" => unlock_door
- "door unlock karo" => unlock_door
- "darwaza lock karo" => lock_door
- "fan chalu karo" => fan_on
- "fan band karo" => fan_off
- "bedroom ki light jala do" => bedroom_light_on
- "bedroom light band karo" => bedroom_light_off
- "hall ki light chalu karo" => hall_light_on
- "hall light band karo" => hall_light_off

6. If the user says only "light on" or "light off"
without specifying bedroom or hall, ask which light they mean.
Use type "clarification" and action "none".

7. General questions and greetings should use type "conversation"
and action "none".

8. Do not claim the physical hardware has successfully changed
before the application receives a successful ESP8266 response.

User command:
${JSON.stringify(userText)}

Return ONLY valid JSON in this format:
{
  "type": "device_action",
  "action": "all_devices_on",
  "response": "Okay, turning on all devices."
}

Use one of these types:
"device_action", "conversation", "clarification"

Use one of these actions:
"lock_door", "unlock_door",
"bedroom_light_on", "bedroom_light_off",
"hall_light_on", "hall_light_off",
"fan_on", "fan_off",
"all_devices_on", "all_devices_off", "none"
`;

  const payload = {
    contents: [
      {
        parts: [
          {
            text: systemInstruction,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };

  const url =
    `${GEMINI_REST_ENDPOINT}/${config.model}:generateContent?key=${apiKey}`;

  async function attemptFetch(retriesLeft) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        const message =
          errorData.error?.message || `HTTP ${response.status}`;

        if (
          (response.status === 503 || response.status === 429) &&
          retriesLeft > 0
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return attemptFetch(retriesLeft - 1);
        }

        throw new Error(message);
      }

      const json = await response.json();

      const rawText =
        json.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!rawText) {
        throw new Error("Empty response from AI.");
      }

      const parsed = JSON.parse(rawText);

      const allowedActions = new Set([
        "lock_door",
        "unlock_door",
        "bedroom_light_on",
        "bedroom_light_off",
        "hall_light_on",
        "hall_light_off",
        "fan_on",
        "fan_off",
        "all_devices_on",
        "all_devices_off",
        "none",
      ]);

      const allowedTypes = new Set([
        "device_action",
        "conversation",
        "clarification",
      ]);

      return {
        type: allowedTypes.has(parsed.type)
          ? parsed.type
          : "conversation",

        action: allowedActions.has(parsed.action)
          ? parsed.action
          : "none",

        response: parsed.response || "Command processed.",
        source: `AI (${config.model})`,
      };
    } catch (error) {
      if (
        retriesLeft > 0 &&
        error.message &&
        error.message.includes("Failed to fetch")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return attemptFetch(retriesLeft - 1);
      }

      throw error;
    }
  }

  return attemptFetch(1);
}

// =========================================================================
// Command Handler: Gemini -> Local Fallback -> ESP8266
// =========================================================================

async function handleTranscript(text) {
  if (!text || !text.trim()) return;

  const userText = text.trim();

  $("transcript").textContent = userText;
  setStatus("Understanding your command...");
  $("micButton").classList.add("processing");

  let result;

  try {
    // Try Gemini first.
    try {
      result = await callGemini(userText);
    } catch (error) {
      console.warn(
        "Gemini unavailable. Using local command interpretation.",
        error
      );

      // Local fallback can still understand common device commands.
      const fallback = localInterpret(userText);

      result = {
        type: fallback.type,
        action: fallback.action,
        response: fallback.response,
        source: "Local Fallback",
      };
    }

    // Execute the interpreted command on the ESP8266.
    let changed = false;

    try {
      changed = await performAction(result.action);
    } catch (error) {
      console.error("ESP8266 command failed:", error);

      const message =
        "I understood your command, but could not reach the ESP8266. " +
        "Connect your phone to ESP8266_Test Wi-Fi and check that the board is powered on.";

      setInterpretation(message, "Hardware Error");
      setStatus(`Hardware command failed: ${error.message}`);

      speakText(message);
      appendHistory(userText, message, "Hardware Error");
      return;
    }

    // Report success only after the ESP8266 responds successfully.
    if (changed) {
      setInterpretation(result.response, result.source);
      setStatus("ESP8266 accepted the hardware command.");
    } else if (result.type === "clarification") {
      setInterpretation(result.response, result.source);
      setStatus("Please clarify which device you mean.");
    } else {
      setInterpretation(result.response, result.source);
      setStatus("Response delivered.");
    }

    speakText(result.response);
    appendHistory(userText, result.response, result.source);
  } finally {
    $("micButton").classList.remove("processing");
  }
}

// =========================================================================
// Speech Recognition Flow
// =========================================================================

function initSpeechRecognition() {
  if (!SpeechRecognition) {
    $("micSupport").textContent = "Mic not supported";
    $("micSupport").style.color = "#ff8585";

    setStatus(
      "Speech recognition is not supported in this WebView. Use the text box."
    );

    return;
  }

  $("micSupport").textContent = "Speech Ready";
  $("micSupport").style.color = "#53e0c0";

  recognition = new SpeechRecognition();
  recognition.lang = config.lang;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;

    $("micButton").classList.add("listening");
    $("micButtonText").textContent = "Listening… tap to stop";
    $("micIcon").textContent = "⏹️";

    setStatus(
      "Listening. Speak in Hindi, English, or Hinglish."
    );
  };

  recognition.onresult = (event) => {
    let interim = "";
    let finalText = "";

    for (
      let i = event.resultIndex;
      i < event.results.length;
      i++
    ) {
      if (event.results[i].isFinal) {
        finalText += event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }

    if (interim && !finalText) {
      $("transcript").textContent = interim + " …";
    }

    if (finalText.trim()) {
      handleTranscript(finalText.trim());
    }
  };

  recognition.onerror = (event) => {
    isListening = false;

    $("micButton").classList.remove("listening");
    $("micButtonText").textContent = "Tap to speak";
    $("micIcon").textContent = "🎙️";

    const messages = {
      "not-allowed":
        "Microphone permission denied. Allow microphone access.",
      "no-speech":
        "No speech detected. Tap the microphone and try again.",
      network:
        "Speech recognition network error. Try typing your command.",
      "service-not-allowed":
        "Speech recognition is blocked by this browser.",
    };

    setStatus(
      messages[event.error] ||
      `Voice error: ${event.error}. You can also type below.`
    );
  };

  recognition.onend = () => {
    isListening = false;

    $("micButton").classList.remove("listening");
    $("micButtonText").textContent = "Tap to speak";
    $("micIcon").textContent = "🎙️";
  };
}

function toggleListening() {
  if (!SpeechRecognition) {
    setStatus(
      "Voice recognition is unavailable. Type your command below."
    );

    $("textCommandInput").focus();
    return;
  }

  if (isListening && recognition) {
    recognition.stop();
    return;
  }

  if (!recognition) {
    initSpeechRecognition();
  }

  if (!recognition) return;

  try {
    recognition.lang = config.lang;
    recognition.start();
  } catch (error) {
    console.warn("Recognition start error:", error);
    setStatus("Microphone busy. Wait a moment and try again.");
  }
}

// =========================================================================
// Gemini and Voice Settings
// =========================================================================

function initSettings() {
  const panel = $("settingsPanel");
  const keyInput = $("apiKeyInput");
  const modelSelect = $("modelSelect");
  const langSelect = $("speechLangSelect");
  const ttsCheckbox = $("ttsCheckbox");

  keyInput.value = config.apiKey;
  modelSelect.value = config.model;
  langSelect.value = config.lang;
  ttsCheckbox.checked = config.ttsEnabled;

  $("settingsToggleBtn").addEventListener("click", () => {
    panel.classList.toggle("hidden");
  });

  $("closeSettingsBtn").addEventListener("click", () => {
    panel.classList.add("hidden");
  });

  $("toggleKeyVisibility").addEventListener("click", () => {
    const isPassword = keyInput.type === "password";

    keyInput.type = isPassword ? "text" : "password";

    $("toggleKeyVisibility").textContent =
      isPassword ? "Hide" : "Show";
  });

  $("saveSettingsBtn").addEventListener("click", () => {
    config.apiKey = keyInput.value.trim();
    config.model = modelSelect.value;
    config.lang = langSelect.value;
    config.ttsEnabled = ttsCheckbox.checked;

    localStorage.setItem("sc_gemini_key", config.apiKey);
    localStorage.setItem("sc_gemini_model", config.model);
    localStorage.setItem("sc_speech_lang", config.lang);
    localStorage.setItem(
      "sc_tts_enabled",
      String(config.ttsEnabled)
    );

    if (recognition) {
      recognition.lang = config.lang;
    }

    panel.classList.add("hidden");
    setStatus("Settings saved successfully.");
  });
}

// =========================================================================
// Manual Device Controls
// =========================================================================

async function runManualAction(action, successMessage) {
  try {
    const changed = await performAction(action);

    if (changed) {
      setInterpretation(successMessage, "Manual");
      setStatus("ESP8266 command completed.");
    }
  } catch (error) {
    console.error("Manual hardware command failed:", error);

    setStatus(
      "Hardware command failed. Connect to ESP8266_Test Wi-Fi and check the board."
    );
  }
}

// =========================================================================
// Event Listeners
// =========================================================================

function initEvents() {
  // Microphone
  $("micButton").addEventListener("click", toggleListening);

  // Typed command input
  $("textCommandForm").addEventListener("submit", (event) => {
    event.preventDefault();

    const input = $("textCommandInput");
    const value = input.value.trim();

    if (value) {
      handleTranscript(value);
      input.value = "";
    }
  });

  // Replay spoken response
  $("replaySpeechBtn").addEventListener("click", () => {
    if (lastAssistantSpeech) {
      speakText(lastAssistantSpeech);
    }
  });

  // Example command buttons
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscript(button.dataset.command);
    });
  });

  // Door buttons
  $("unlockButton").addEventListener("click", () => {
    runManualAction(
      "unlock_door",
      "Door unlock command sent successfully."
    );
  });

  $("lockButton").addEventListener("click", () => {
    runManualAction(
      "lock_door",
      "Door lock command sent successfully."
    );
  });

  // Bedroom light
  $("bedroomToggle").addEventListener("change", (event) => {
    const action = event.target.checked
      ? "bedroom_light_on"
      : "bedroom_light_off";

    runManualAction(
      action,
      `Bedroom light ${event.target.checked ? "ON" : "OFF"}.`
    );
  });

  // Hall light
  $("hallToggle").addEventListener("change", (event) => {
    const action = event.target.checked
      ? "hall_light_on"
      : "hall_light_off";

    runManualAction(
      action,
      `Hall light ${event.target.checked ? "ON" : "OFF"}.`
    );
  });

  // Fan
  $("fanToggle").addEventListener("change", (event) => {
    const action = event.target.checked
      ? "fan_on"
      : "fan_off";

    runManualAction(
      action,
      `Fan ${event.target.checked ? "ON" : "OFF"}.`
    );
  });

  // Reset: lock door and switch off all loads.
  $("resetButton").addEventListener("click", async () => {
    try {
      await performAction("all_devices_off");

      $("transcript").textContent =
        "Your spoken command or typed text will appear here…";

      setInterpretation(
        "All devices switched off and the door locked.",
        "System"
      );

      setStatus("Hardware reset completed.");
    } catch (error) {
      console.error("Hardware reset failed:", error);

      setStatus(
        "Could not reset hardware. Check the ESP8266 Wi-Fi connection."
      );
    }
  });

  // Clear conversation history
  $("clearHistoryBtn").addEventListener("click", () => {
    state.history = [];
    $("historyList").innerHTML =
      '<p class="history-empty">No commands yet. Speak or type above to start.</p>';
  });
}

// =========================================================================
// Application Startup
// =========================================================================

window.addEventListener("DOMContentLoaded", () => {
  renderDevices();
  initSettings();
  initEvents();
  initSpeechRecognition();
  refreshHardwareStatus();
});
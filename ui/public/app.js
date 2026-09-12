// ==============================================================================
// Vintoria Sales Agent × DeepSeek — Client Application
// ==============================================================================

(function () {
  // DOM Elements
  const chatMessages = document.getElementById("chat-messages");
  const heroCard = document.getElementById("hero-card");
  const promptInput = document.getElementById("prompt-input");
  const btnSend = document.getElementById("btn-send");
  const btnStop = document.getElementById("btn-stop");
  const modelSelect = document.getElementById("model-select");
  const deepThinkToggle = document.getElementById("deep-think-toggle");
  const tokenCounter = document.getElementById("token-counter");
  const promptStatus = document.getElementById("prompt-status");
  const chipModelName = document.getElementById("chip-model-name");
  const connectionStatus = document.getElementById("connection-status");
  const btnNewChat = document.getElementById("btn-new-chat");
  const btnTerminal = document.getElementById("btn-terminal");
  const btnFiles = document.getElementById("btn-files");
  const btnSettings = document.getElementById("btn-settings");
  const drawerRight = document.getElementById("drawer-right");
  const drawerTabs = document.querySelectorAll(".drawer-tab");
  const tabFiles = document.getElementById("tab-files");
  const tabTerminal = document.getElementById("tab-terminal");
  const fileTree = document.getElementById("file-tree");
  const fileSearchInput = document.getElementById("file-search-input");
  const terminalInput = document.getElementById("terminal-input");
  const terminalLogs = document.getElementById("terminal-logs");
  const settingsModal = document.getElementById("settings-modal");
  const modalClose = document.getElementById("modal-close");
  const modalApiKey = document.getElementById("modal-api-key");
  const modalBaseUrl = document.getElementById("modal-base-url");
  const modalDefaultModel = document.getElementById("modal-default-model");
  const btnToggleKeyVisibility = document.getElementById("btn-toggle-key-visibility");
  const btnTestKey = document.getElementById("btn-test-key");
  const testStatus = document.getElementById("test-status");
  const btnSaveSettings = document.getElementById("btn-save-settings");
  const workflowCards = document.querySelectorAll(".workflow-card");

  // Application State
  let ws = null;
  let isGenerating = false;
  let currentModel = "deepseek-chat";
  let totalSessionTokens = 0;
  let activeAssistantCard = null;
  let activeReasoningBox = null;
  let activeReasoningContent = null;
  let activeReasoningTimer = null;
  let activeMarkdownBody = null;
  let accumulatedText = "";
  let accumulatedThinking = "";
  let thinkingStartTime = 0;
  let thinkingTimerInterval = null;
  let particleSpeedMultiplier = 1;

  // Initialize Markdown rendering
  if (window.marked) {
    marked.setOptions({
      highlight: function (code, lang) {
        if (window.hljs) {
          const validLang = hljs.getLanguage(lang) ? lang : "plaintext";
          return hljs.highlight(code, { language: validLang }).value;
        }
        return code;
      },
      breaks: true,
      gfm: true,
    });
  }

  // ==============================================================================
  // WebSocket Gateway & Connection
  // ==============================================================================
  function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[WS] Connected to Vintoria Sales Agent runner");
      updateConnectionStatus(true, "DeepSeek Active");
    };

    ws.onclose = () => {
      console.warn("[WS] Disconnected. Reconnecting in 2s...");
      updateConnectionStatus(false, "Reconnecting...");
      if (isGenerating) {
        clearInterval(thinkingTimerInterval);
        setGeneratingState(false);
        particleSpeedMultiplier = 1;
        renderSystemNote("Connection dropped mid-run. Reconnecting — send again if the answer never arrived.", true);
      }
      setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = (err) => {
      console.error("[WS] Error:", err);
      updateConnectionStatus(false, "Error");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleServerEvent(data);
      } catch (e) {
        console.error("Error parsing WS frame:", e);
      }
    };
  }

  function updateConnectionStatus(isOnline, label) {
    const dot = connectionStatus.querySelector(".status-dot");
    const lbl = connectionStatus.querySelector(".status-label");
    if (isOnline) {
      dot.className = "status-dot online";
      lbl.textContent = label || "DeepSeek Active";
      connectionStatus.style.borderColor = "rgba(16, 185, 129, 0.25)";
    } else {
      dot.className = "status-dot offline";
      lbl.textContent = label || "Offline";
      connectionStatus.style.borderColor = "rgba(239, 68, 68, 0.25)";
    }
  }

  // ==============================================================================
  // Event Dispatcher for Streaming & Tools
  // ==============================================================================
  function handleServerEvent(data) {
    switch (data.type) {
      case "connected":
        if (data.model) {
          currentModel = data.model;
          modelSelect.value = data.model;
          updateModelPill(data.model);
        }
        break;

      case "agent_start":
        setGeneratingState(true);
        particleSpeedMultiplier = 2.8; // Accelerate particle mesh when thinking
        createAssistantMessageContainer(data.isReasoner);
        break;

      case "thinking_delta":
        appendThinking(data.delta, data.elapsedMs);
        break;

      case "text_delta":
        appendText(data.delta);
        break;

      case "tool_start":
        renderToolStart(data.callId, data.tool, data.args);
        break;

      case "tool_end":
        renderToolEnd(data.callId, data.tool, data.result);
        break;

      case "agent_end":
        finishAgentTurn(data.durationMs, data.tokensEstimate);
        break;

      case "aborted":
        handleAborted();
        break;

      case "error":
        handleServerError(data.error);
        break;

      case "session_cleared":
        clearInterval(thinkingTimerInterval);
        setGeneratingState(false);
        particleSpeedMultiplier = 1;
        break;
    }
  }

  function renderSystemNote(text, isError) {
    if (heroCard) heroCard.style.display = "none";
    const msgCard = document.createElement("div");
    msgCard.className = "message-card assistant";
    msgCard.innerHTML = `<div class="assistant-bubble"><div style="background: ${isError ? "rgba(239, 68, 68, 0.15)" : "rgba(0, 240, 255, 0.08)"}; border: 1px solid ${isError ? "var(--accent-danger)" : "var(--accent-cyan)"}; border-radius: 8px; padding: 12px; color: ${isError ? "#fca5a5" : "var(--text-secondary)"}; font-size: 13px;">${escapeHtml(text)}</div></div>`;
    chatMessages.appendChild(msgCard);
    scrollToBottom();
  }

  // ==============================================================================
  // Message Rendering
  // ==============================================================================
  function renderUserMessage(text) {
    if (heroCard) heroCard.style.display = "none";

    const msgCard = document.createElement("div");
    msgCard.className = "message-card user";

    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = text;

    msgCard.appendChild(bubble);
    chatMessages.appendChild(msgCard);
    scrollToBottom();
  }

  function createAssistantMessageContainer(isReasoner) {
    accumulatedText = "";
    accumulatedThinking = "";
    thinkingStartTime = Date.now();

    const msgCard = document.createElement("div");
    msgCard.className = "message-card assistant";

    const bubble = document.createElement("div");
    bubble.className = "assistant-bubble";

    // Author row with Vintoria Sales Agent logo avatar
    const authorRow = document.createElement("div");
    authorRow.className = "assistant-author-row";
    authorRow.innerHTML = `
      <img src="/assets/logo.png" alt="Vintoria" class="assistant-avatar-img">
      <span class="assistant-author-name">Vintoria Sales Agent</span>
      <span class="assistant-model-tag">${escapeHtml(currentModel)}</span>
    `;
    bubble.appendChild(authorRow);

    // Create Reasoning Accordion if model produces chain-of-thought
    if (isReasoner || currentModel.includes("reasoner") || deepThinkToggle.classList.contains("active")) {
      activeReasoningBox = document.createElement("div");
      activeReasoningBox.className = "reasoning-box";

      const header = document.createElement("div");
      header.className = "reasoning-header";
      header.innerHTML = `
        <div class="reasoning-title">
          <div class="reasoning-spinner"></div>
          <span>DeepSeek R1 Reasoning Process</span>
        </div>
        <div class="reasoning-timer">0.0s</div>
      `;

      activeReasoningContent = document.createElement("div");
      activeReasoningContent.className = "reasoning-content";

      header.addEventListener("click", () => {
        activeReasoningBox.classList.toggle("collapsed");
      });

      activeReasoningBox.appendChild(header);
      activeReasoningBox.appendChild(activeReasoningContent);
      bubble.appendChild(activeReasoningBox);

      activeReasoningTimer = header.querySelector(".reasoning-timer");

      // Live thinking timer ticker
      clearInterval(thinkingTimerInterval);
      thinkingTimerInterval = setInterval(() => {
        if (activeReasoningTimer) {
          const sec = ((Date.now() - thinkingStartTime) / 1000).toFixed(1);
          activeReasoningTimer.textContent = `${sec}s`;
        }
      }, 100);
    } else {
      activeReasoningBox = null;
      activeReasoningContent = null;
    }

    // Markdown text container
    activeMarkdownBody = document.createElement("div");
    activeMarkdownBody.className = "markdown-body";
    activeMarkdownBody.innerHTML = '<span class="cursor-typing">▍</span>';

    bubble.appendChild(activeMarkdownBody);
    msgCard.appendChild(bubble);
    chatMessages.appendChild(msgCard);

    activeAssistantCard = msgCard;
    scrollToBottom();
  }

  function appendThinking(delta, elapsedMs) {
    accumulatedThinking += delta;
    if (activeReasoningContent) {
      activeReasoningContent.textContent = accumulatedThinking;
      activeReasoningContent.scrollTop = activeReasoningContent.scrollHeight;
    }
    if (activeReasoningTimer && elapsedMs) {
      activeReasoningTimer.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
    }
    scrollToBottom();
  }

  function appendText(delta) {
    accumulatedText += delta;
    if (activeMarkdownBody) {
      if (window.marked) {
        activeMarkdownBody.innerHTML = marked.parse(accumulatedText);
        attachCopyButtons(activeMarkdownBody);
      } else {
        activeMarkdownBody.textContent = accumulatedText;
      }
    }
    scrollToBottom();
  }

  function renderToolStart(callId, toolName, args) {
    const card = document.createElement("div");
    card.className = "tool-card";
    card.id = `tool-${callId}`;

    card.innerHTML = `
      <div class="tool-header">
        <div class="tool-name-tag">
          <span>⚡</span>
          <span>${toolName}</span>
        </div>
        <span class="tool-status-badge running">Running...</span>
      </div>
      <div class="tool-body"><code>${escapeHtml(JSON.stringify(args, null, 2))}</code></div>
    `;

    if (activeAssistantCard) {
      const bubble = activeAssistantCard.querySelector(".assistant-bubble");
      bubble.insertBefore(card, activeMarkdownBody);
    }
    scrollToBottom();
  }

  function renderToolEnd(callId, toolName, result) {
    const card = document.getElementById(`tool-${callId}`);
    if (card) {
      const badge = card.querySelector(".tool-status-badge");
      const body = card.querySelector(".tool-body");

      if (result.success) {
        badge.className = "tool-status-badge success";
        badge.textContent = `Completed (${result.duration || 0}ms)`;
      } else {
        badge.className = "tool-status-badge failed";
        badge.textContent = `Failed (${result.duration || 0}ms)`;
      }

      body.innerHTML = `<pre><code>${escapeHtml(result.output || "Done.")}</code></pre>`;
    }
    scrollToBottom();
  }

  function finishAgentTurn(durationMs, tokensEstimate) {
    clearInterval(thinkingTimerInterval);
    setGeneratingState(false);
    particleSpeedMultiplier = 1;

    if (activeReasoningBox) {
      // Auto-collapse completed reasoning accordion to keep interface neat
      const spinner = activeReasoningBox.querySelector(".reasoning-spinner");
      if (spinner) spinner.style.display = "none";
      activeReasoningBox.classList.add("collapsed");
    }

    if (tokensEstimate) {
      totalSessionTokens += tokensEstimate;
      tokenCounter.textContent = `${totalSessionTokens.toLocaleString()} tokens`;
    }

    activeAssistantCard = null;
    activeMarkdownBody = null;
    activeReasoningBox = null;
    activeReasoningContent = null;
    activeReasoningTimer = null;
    scrollToBottom();
  }

  function handleAborted() {
    clearInterval(thinkingTimerInterval);
    setGeneratingState(false);
    particleSpeedMultiplier = 1;

    if (activeMarkdownBody) {
      activeMarkdownBody.innerHTML += '<p style="color: var(--accent-danger); font-size: 12px; margin-top: 10px;">[Generation aborted by user]</p>';
    } else {
      renderSystemNote("[Generation aborted by user]", true);
    }
    activeAssistantCard = null;
    activeMarkdownBody = null;
  }

  function handleServerError(err) {
    clearInterval(thinkingTimerInterval);
    setGeneratingState(false);
    particleSpeedMultiplier = 1;

    if (activeMarkdownBody) {
      activeMarkdownBody.innerHTML += `<div style="background: rgba(239, 68, 68, 0.15); border: 1px solid var(--accent-danger); border-radius: 8px; padding: 12px; color: #fca5a5; margin-top: 10px;"><strong>Error:</strong> ${escapeHtml(err)}</div>`;
    } else {
      renderSystemNote(`Error: ${err}`, true);
    }
    activeAssistantCard = null;
    activeMarkdownBody = null;
  }

  // ==============================================================================
  // UI Interaction & Action Handlers
  // ==============================================================================
  function sendPrompt() {
    const text = promptInput.value.trim();
    if (!text || isGenerating) return;

    renderUserMessage(text);
    promptInput.value = "";
    autoResizeTextarea();

    const isDeepThink = deepThinkToggle.classList.contains("active");
    const effectiveModel = isDeepThink ? "deepseek-reasoner" : currentModel;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "prompt",
          message: text,
          model: effectiveModel,
          tools: true,
        }),
      );
    } else {
      renderSystemNote("Not connected yet — wait for 'DeepSeek Active' and send again.", true);
      promptInput.value = text;
    }
  }

  function abortGeneration() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "abort" }));
    }
  }

  function setGeneratingState(generating) {
    isGenerating = generating;
    if (generating) {
      btnSend.classList.add("hidden");
      btnStop.classList.remove("hidden");
      promptStatus.textContent = "Autonomous Agent Running...";
      promptStatus.style.color = "var(--accent-cyan)";
    } else {
      btnSend.classList.remove("hidden");
      btnStop.classList.add("hidden");
      promptStatus.textContent = "Ready";
      promptStatus.style.color = "var(--text-muted)";
    }
  }

  function updateModelPill(model) {
    chipModelName.textContent = model;
    if (model.includes("reasoner") || model.includes("r1")) {
      deepThinkToggle.classList.add("active");
    } else {
      deepThinkToggle.classList.remove("active");
    }
  }

  function autoResizeTextarea() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + "px";
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function attachCopyButtons(container) {
    container.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code")?.innerText || pre.innerText;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy"), 2000);
        });
      });
      pre.appendChild(btn);
    });
  }

  // ==============================================================================
  // Event Listeners
  // ==============================================================================
  btnSend.addEventListener("click", sendPrompt);
  btnStop.addEventListener("click", abortGeneration);

  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      clearChat();
    }
  });

  promptInput.addEventListener("input", autoResizeTextarea);

  modelSelect.addEventListener("change", (e) => {
    currentModel = e.target.value;
    updateModelPill(currentModel);
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: currentModel }),
    });
  });

  deepThinkToggle.addEventListener("click", () => {
    deepThinkToggle.classList.toggle("active");
    if (deepThinkToggle.classList.contains("active")) {
      currentModel = "deepseek-reasoner";
      modelSelect.value = "deepseek-reasoner";
    } else {
      currentModel = "deepseek-chat";
      modelSelect.value = "deepseek-chat";
    }
    updateModelPill(currentModel);
  });

  function clearChat() {
    chatMessages.innerHTML = "";
    if (heroCard) {
      chatMessages.appendChild(heroCard);
      heroCard.style.display = "block";
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "new_session" }));
    }
  }

  btnNewChat.addEventListener("click", clearChat);

  workflowCards.forEach((card) => {
    card.addEventListener("click", () => {
      const p = card.getAttribute("data-prompt");
      if (p) {
        promptInput.value = p;
        autoResizeTextarea();
        sendPrompt();
      }
    });
  });

  // Drawer Toggling
  btnTerminal.addEventListener("click", () => {
    drawerRight.classList.toggle("hidden");
    switchDrawerTab("terminal");
  });

  btnFiles.addEventListener("click", () => {
    drawerRight.classList.toggle("hidden");
    switchDrawerTab("files");
    loadFilesTree();
  });

  drawerTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const t = tab.getAttribute("data-tab");
      switchDrawerTab(t);
    });
  });

  function switchDrawerTab(tabName) {
    drawerTabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === tabName));
    tabFiles.classList.toggle("hidden", tabName !== "files");
    tabTerminal.classList.toggle("hidden", tabName !== "terminal");
  }

  // Workspace Files Loader
  async function loadFilesTree() {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      if (data.tree) {
        renderFileTree(data.tree);
      }
    } catch (e) {
      fileTree.innerHTML = `<div style="color: var(--accent-danger);">Error loading files: ${e.message}</div>`;
    }
  }

  function renderFileTree(tree, container = fileTree) {
    container.innerHTML = "";
    function build(nodes, el) {
      nodes.forEach((node) => {
        const item = document.createElement("div");
        item.className = "file-tree-item";
        item.innerHTML = `<span>${node.type === "dir" ? "📁" : "📄"}</span><span>${node.name}</span>`;
        item.addEventListener("click", () => {
          if (node.type === "file") {
            promptInput.value = `Read file @${node.path} and analyze its implementation.`;
            autoResizeTextarea();
          }
        });
        el.appendChild(item);
        if (node.children && node.children.length > 0) {
          const sub = document.createElement("div");
          sub.style.paddingLeft = "16px";
          build(node.children, sub);
          el.appendChild(sub);
        }
      });
    }
    build(tree, container);
  }

  // Terminal Runner
  terminalInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const cmd = terminalInput.value.trim();
      if (!cmd) return;
      terminalInput.value = "";

      const line = document.createElement("div");
      line.className = "log-line info";
      line.textContent = `$ ${cmd}`;
      terminalLogs.appendChild(line);

      try {
        const res = await fetch("/api/tools/bash", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: cmd }),
        });
        const data = await res.json();
        const out = document.createElement("div");
        out.className = data.success ? "log-line success" : "log-line error";
        out.textContent = data.output;
        terminalLogs.appendChild(out);
      } catch (err) {
        const errLine = document.createElement("div");
        errLine.className = "log-line error";
        errLine.textContent = err.message;
        terminalLogs.appendChild(errLine);
      }
      terminalLogs.scrollTop = terminalLogs.scrollHeight;
    }
  });

  // Settings Modal
  const modalOpenwaUrl = document.getElementById("modal-openwa-url");
  const modalOpenwaKey = document.getElementById("modal-openwa-key");
  const modalOpenwaSession = document.getElementById("modal-openwa-session");
  btnSettings.addEventListener("click", async () => {
    settingsModal.classList.remove("hidden");
    const res = await fetch("/api/status");
    const data = await res.json();
    if (data.keyMasked) modalApiKey.placeholder = data.keyMasked;
    if (data.baseUrl) modalBaseUrl.value = data.baseUrl;
    if (data.currentModel) modalDefaultModel.value = data.currentModel;
    if (data.openwa) {
      if (data.openwa.baseUrl && modalOpenwaUrl) modalOpenwaUrl.value = data.openwa.baseUrl;
      if (data.openwa.session && modalOpenwaSession) modalOpenwaSession.value = data.openwa.session;
      if (modalOpenwaKey) modalOpenwaKey.placeholder = data.openwa.hasKey ? "configured ✓" : "owa_k1_...";
    }
  });

  modalClose.addEventListener("click", () => settingsModal.classList.add("hidden"));

  btnToggleKeyVisibility.addEventListener("click", () => {
    if (modalApiKey.type === "password") {
      modalApiKey.type = "text";
      btnToggleKeyVisibility.textContent = "Hide";
    } else {
      modalApiKey.type = "password";
      btnToggleKeyVisibility.textContent = "Show";
    }
  });

  btnTestKey.addEventListener("click", async () => {
    testStatus.textContent = "Testing...";
    testStatus.style.color = "var(--accent-cyan)";
    try {
      const res = await fetch("/api/test-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: modalApiKey.value.trim(),
          baseUrl: modalBaseUrl.value.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        testStatus.textContent = "✓ Connected!";
        testStatus.style.color = "var(--accent-green)";
      } else {
        testStatus.textContent = `✗ Failed: ${data.error}`;
        testStatus.style.color = "var(--accent-danger)";
      }
    } catch (e) {
      testStatus.textContent = `✗ Error: ${e.message}`;
      testStatus.style.color = "var(--accent-danger)";
    }
  });

  btnSaveSettings.addEventListener("click", async () => {
    const payload = {
      baseUrl: modalBaseUrl.value.trim(),
      model: modalDefaultModel.value,
    };
    if (modalApiKey.value.trim()) {
      payload.apiKey = modalApiKey.value.trim();
    }
    if (modalOpenwaUrl && modalOpenwaUrl.value.trim()) payload.openwaBaseUrl = modalOpenwaUrl.value.trim();
    if (modalOpenwaKey && modalOpenwaKey.value.trim()) payload.openwaApiKey = modalOpenwaKey.value.trim();
    if (modalOpenwaSession && modalOpenwaSession.value.trim()) payload.openwaSession = modalOpenwaSession.value.trim();
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    currentModel = payload.model;
    modelSelect.value = currentModel;
    updateModelPill(currentModel);
    settingsModal.classList.add("hidden");
  });

  // ==============================================================================
  // Ambient Particle Constellation Background Animation
  // ==============================================================================
  const canvas = document.getElementById("bg-canvas");
  const ctx = canvas.getContext("2d");
  let particles = [];
  let mouseX = -1000;
  let mouseY = -1000;

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  window.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  class Particle {
    constructor() {
      this.reset();
    }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.vx = (Math.random() - 0.5) * 0.7;
      this.vy = (Math.random() - 0.5) * 0.7;
      this.radius = Math.random() * 2 + 1;
      this.color = Math.random() > 0.4 ? "rgba(0, 240, 255," : "rgba(157, 78, 221,";
      this.baseAlpha = Math.random() * 0.5 + 0.2;
    }
    update() {
      this.x += this.vx * particleSpeedMultiplier;
      this.y += this.vy * particleSpeedMultiplier;

      if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
      if (this.y < 0 || this.y > canvas.height) this.vy *= -1;

      // Mouse gentle repel
      const dx = mouseX - this.x;
      const dy = mouseY - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 120) {
        this.x -= (dx / dist) * 1.5;
        this.y -= (dy / dist) * 1.5;
      }
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = `${this.color} ${this.baseAlpha})`;
      ctx.shadowBlur = 8;
      ctx.shadowColor = this.color.includes("240") ? "rgba(0, 240, 255, 0.6)" : "rgba(157, 78, 221, 0.6)";
      ctx.fill();
    }
  }

  const PARTICLE_COUNT = Math.min(Math.floor((window.innerWidth * window.innerHeight) / 14000), 80);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push(new Particle());
  }

  function animateParticles() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Connect particles within proximity
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 130) {
          const alpha = (1 - dist / 130) * 0.22;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(0, 240, 255, ${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }

    particles.forEach((p) => {
      p.update();
      p.draw();
    });

    requestAnimationFrame(animateParticles);
  }
  animateParticles();

  // Initialize
  connectWebSocket();
})();

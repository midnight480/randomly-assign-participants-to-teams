(function () {
  const API = "/api";

  function getPath() {
    return window.location.pathname;
  }

  function parseRoute(path) {
    const m = path.match(/^\/e\/([^/]+)(?:\/(admin|display))?\/?$/);
    if (m) {
      return { eventCode: m[1], mode: m[2] || "participant" };
    }
    return null;
  }

  function getEventCode() {
    const r = parseRoute(getPath());
    return r ? r.eventCode : null;
  }

  async function fetchEvent(eventCode) {
    const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "イベントの取得に失敗しました");
    }
    return res.json();
  }

  async function draw(eventCode, displayName) {
    const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}/draw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "くじの抽選に失敗しました");
    }
    return data;
  }

  function normalizeName(name) {
    return name.trim().replace(/\s+/g, " ").slice(0, 30);
  }

  function vibrate(ms) {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(ms);
    }
  }

  function showToast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 2500);
  }

  function renderParticipantPage(eventCode, data) {
    const event = data;
    const totalSlots = event.total_slots || 0;
    const assigned = event.assigned_count || 0;
    const remaining = event.remaining_slots ?? totalSlots - assigned;

    let html = `
      <div class="container">
        <h1>${escapeHtml(event.title || "くじ引き")}</h1>
        <p class="subtitle">${escapeHtml(event.event_code)}</p>
        <div class="status-bar">
          <span>参加済み ${assigned} / ${totalSlots} 名</span>
          <span>残り枠 ${remaining}</span>
        </div>
        <div class="card">
          <label for="displayName">表示名（氏名・ニックネーム）</label>
          <input type="text" id="displayName" placeholder="例）しばお / 佐賀太郎" maxlength="30" />
          <p id="drawError" class="error-msg" style="display:none"></p>
          <button type="button" id="drawBtn">くじを引く</button>
        </div>
        <div id="resultArea"></div>
        <div class="card">
          <h2 style="font-size:1.1rem; margin:0 0 12px">チーム一覧</h2>
          <div class="teams-grid" id="teamsList"></div>
        </div>
        <a href="/e/${encodeURIComponent(eventCode)}/display" class="nav-link">会場表示モード（TV/プロジェクター）</a>
        <a href="/e/${encodeURIComponent(eventCode)}/admin" class="nav-link">管理画面</a>
      </div>
    `;

    document.getElementById("app").innerHTML = html;

    const displayNameInput = document.getElementById("displayName");
    const drawBtn = document.getElementById("drawBtn");
    const drawError = document.getElementById("drawError");
    const resultArea = document.getElementById("resultArea");
    const teamsList = document.getElementById("teamsList");

    function showError(msg) {
      drawError.textContent = msg;
      drawError.style.display = msg ? "block" : "none";
    }

    function teamLabel(name) {
      return name ? `『${escapeHtml(name)}チーム』` : "チーム";
    }
    function renderTeams() {
      const teams = event.teams || [];
      teamsList.innerHTML = teams
        .map(
          (t) => `
        <div class="team-card">
          <h3>${teamLabel(t.name)}（${t.assigned}/${t.size}）</h3>
          <div class="members">${(t.members || []).map((m) => `<span>${escapeHtml(m)}</span>`).join("") || "—"}</div>
        </div>
      `
        )
        .join("");
    }

    renderTeams();

    let isDrawing = false;
    let pollTimer = null;

    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(() => {
        if (isDrawing) return;
        fetchEvent(eventCode).then((newData) => {
          event.teams = newData.teams;
          event.assigned_count = newData.assigned_count;
          event.remaining_slots = newData.remaining_slots;
          if (document.getElementById("teamsList")) renderTeams();
          const bar = document.querySelector(".status-bar");
          if (bar) bar.innerHTML = `参加済み ${newData.assigned_count || 0} / ${newData.total_slots || 0} 名　<span>残り枠 ${newData.remaining_slots ?? 0}</span>`;
        }).catch(() => {});
      }, 3000);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function runDrawAnimation(teamNames, durationMs, onTick) {
      const start = Date.now();
      let frame = 0;
      function tick() {
        const elapsed = Date.now() - start;
        if (elapsed >= durationMs) return;
        const idx = Math.floor((elapsed / 80)) % teamNames.length;
        onTick(teamNames[idx]);
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    drawBtn.addEventListener("click", async () => {
      const raw = displayNameInput.value;
      const name = normalizeName(raw);
      if (!name) {
        showError("表示名を入力してください");
        return;
      }
      showError("");
      drawBtn.disabled = true;
      isDrawing = true;
      const teamNames = (event.teams || []).map((t) => (t.name ? t.name + "チーム" : "?"));
      const duration = 1200 + Math.random() * 800;

      resultArea.innerHTML = `
        <div class="card draw-animation">
          <p class="dots" style="margin-bottom:12px">抽選中</p>
          <p class="slot-text" id="slotText">${teamNames[0] || "?"}</p>
        </div>
      `;
      const slotEl = document.getElementById("slotText");
      runDrawAnimation(teamNames.length ? teamNames : ["?"], duration, (t) => {
        if (slotEl) slotEl.textContent = t;
      });
      vibrate(30);
      setTimeout(() => vibrate(25), 400);

      try {
        const result = await draw(eventCode, name);
        localStorage.setItem("event_" + eventCode + "_name", name);
        resultArea.innerHTML = `
          <div class="card result-card confetti decide">
            <p class="decide-label">決定！</p>
            <p class="result-message">あなたは${result.team_name ? `『${escapeHtml(result.team_name)}チーム』` : "チーム"}です！</p>
            <p class="label">${escapeHtml(result.display_name)} さん</p>
          </div>
        `;
        resultArea.scrollIntoView({ behavior: "smooth" });
        const newData = await fetchEvent(eventCode);
        event.teams = newData.teams;
        event.assigned_count = newData.assigned_count;
        event.remaining_slots = newData.remaining_slots;
        renderTeams();
      } catch (e) {
        showError(e.message || "エラーが発生しました");
        resultArea.innerHTML = "";
      } finally {
        drawBtn.disabled = false;
        isDrawing = false;
      }
    });

    startPolling();

    displayNameInput.addEventListener("input", function () {
      const v = this.value.trim().replace(/\s+/g, " ");
      if (v !== this.value) this.value = v;
      if (this.value.length > 30) this.value = this.value.slice(0, 30);
    });
    displayNameInput.addEventListener("blur", function () {
      this.value = normalizeName(this.value);
    });

    const savedName = localStorage.getItem("event_" + eventCode + "_name");
    if (savedName) {
      displayNameInput.value = savedName;
      drawBtn.disabled = true;
      draw(eventCode, savedName)
        .then((result) => {
          resultArea.innerHTML = `
            <div class="card result-card confetti">
              <p class="result-message">あなたは${result.team_name ? `『${escapeHtml(result.team_name)}チーム』` : "チーム"}です！</p>
              <p class="label">${escapeHtml(result.display_name)} さん</p>
            </div>
          `;
        })
        .catch(() => {})
        .finally(() => { drawBtn.disabled = false; });
    }
  }

  const PRESETS = [
    { name: "4チーム (4,4,5,5)", teams: [{ name: "", size: 4 }, { name: "", size: 4 }, { name: "", size: 5 }, { name: "", size: 5 }] },
    { name: "5チーム (3,3,4,4,4)", teams: [{ name: "", size: 3 }, { name: "", size: 3 }, { name: "", size: 4 }, { name: "", size: 4 }, { name: "", size: 4 }] },
  ];

  function patternToCustomString(pattern) {
    if (!pattern?.teams?.length) return "";
    return pattern.teams.map((t) => t.size).join(",");
  }

  function parseCustomPattern(str) {
    const parts = str.trim().split(/[\s,]+/).filter(Boolean).map((s) => parseInt(s, 10));
    if (parts.some((n) => isNaN(n) || n < 1)) return null;
    return { teams: parts.map((size) => ({ name: "", size })) };
  }

  /** チーム数と総枠から均等配分の人数配列を返す（余りは先頭チームに+1） */
  function distributeSlots(numTeams, totalSlots) {
    if (numTeams < 1 || totalSlots < numTeams) return [];
    const base = Math.floor(totalSlots / numTeams);
    const rem = totalSlots % numTeams;
    const sizes = [];
    for (let i = 0; i < numTeams; i++) sizes.push(i < rem ? base + 1 : base);
    return sizes;
  }

  function renderAdminPage(eventCode, eventData) {
    const event = eventData || {};
    const currentPattern = event.pattern || { teams: [] };
    const customStr = patternToCustomString(currentPattern);

    document.getElementById("app").innerHTML = `
      <div class="container">
        <h1>管理画面</h1>
        <p class="subtitle">${escapeHtml(eventCode)}</p>
        <div class="card">
          <h2 style="font-size:1rem; margin:0 0 12px">現在のチーム名</h2>
          <p id="adminTeamNamesList" class="admin-team-names">${(currentPattern.teams || []).map((t) => escapeHtml(t.name || "—")).join("、") || "（未設定）"}</p>
          <button type="button" id="regenerateTeamNames" class="secondary" style="margin-top:8px" ${(event.assigned_count || 0) > 0 ? "disabled title=\"割り当てが0人のときのみ利用できます\"" : ""}>チーム名再生成</button>
          <p id="adminRegenerateMessage" class="error-msg" style="display:none; margin-top:8px"></p>
        </div>
        <div class="card">
          <h2 style="font-size:1rem; margin:0 0 12px">イベント設定</h2>
          <label for="adminEventTitle">イベント名</label>
          <input type="text" id="adminEventTitle" value="${escapeHtml(event.title || "")}" placeholder="例）ちょいラク アイディアソン" />
          <label style="margin-top:12px">チーム数・参加人数</label>
          <div class="admin-quick-pattern" style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:8px">
            <label class="admin-inline-label">チーム数 <input type="number" id="adminTeamCount" min="1" max="26" value="${currentPattern.teams?.length || 4}" style="width:4em" /></label>
            <label class="admin-inline-label">参加人数（総枠） <input type="number" id="adminTotalSlots" min="1" value="${(currentPattern.teams || []).reduce((s, t) => s + (t.size || 0), 0) || 18}" style="width:4em" /></label>
          </div>
          <p class="admin-pattern-hint" style="margin-top:0">上記を変更すると下の「カスタム」に均等配分で反映されます。既に割り当て済みの人数より少ない総枠にはできません。</p>
          ${(event.assigned_count || 0) > 0 ? `<p class="admin-pattern-hint" style="color:var(--c-warning)">現在 ${event.assigned_count} 名割り当て済みです。総枠は ${event.assigned_count} 名以上にしてください。</p>` : ""}
          <label style="margin-top:12px">チーム構成（プリセット or カスタム）</label>
          <div class="admin-presets" id="adminPresets">
            ${PRESETS.map((p, i) => {
              const pStr = p.teams.map((t) => t.size).join(",");
              const isMatch = customStr === pStr;
              return `
              <label class="admin-preset-label">
                <input type="radio" name="patternPreset" value="${i}" ${isMatch ? "checked" : ""} />
                ${escapeHtml(p.name)}
              </label>
            `;
            }).join("")}
            <label class="admin-preset-label">
              <input type="radio" name="patternPreset" value="custom" ${PRESETS.some((p) => customStr === p.teams.map((t) => t.size).join(",")) ? "" : "checked"} />
              カスタム
            </label>
          </div>
          <input type="text" id="adminPatternCustom" class="admin-pattern-custom" placeholder="例）4,4,5,5" value="${escapeHtml(customStr)}" />
          <p class="admin-pattern-hint">カスタム時は各チームの人数をカンマ区切りで入力（例: 4,4,5,5 → A:4 B:4 C:5 D:5）</p>
          <button type="button" id="adminSaveEvent" class="secondary" style="margin-top:12px">設定を保存</button>
          <p id="adminSettingMessage" class="error-msg" style="display:none; margin-top:8px"></p>
        </div>
        <div class="card">
          <label for="adminToken">管理者トークン</label>
          <input type="password" id="adminToken" placeholder="管理者トークンを入力" />
          <div id="adminStatus" class="status-bar"></div>
          <div class="admin-actions">
            <button type="button" id="resetAssignments" class="secondary">割り当てをリセット</button>
            <button type="button" id="resetAll" class="danger">割り当て・氏名をすべてリセット</button>
          </div>
          <p id="adminMessage" class="error-msg" style="display:none; margin-top:12px"></p>
        </div>
        <a href="/e/${encodeURIComponent(eventCode)}/display" class="nav-link">会場表示モード</a>
        <a href="/e/${encodeURIComponent(eventCode)}" class="nav-link">← 参加画面に戻る</a>
      </div>
    `;

    const adminToken = document.getElementById("adminToken");
    const adminStatus = document.getElementById("adminStatus");
    const adminMessage = document.getElementById("adminMessage");
    const adminEventTitle = document.getElementById("adminEventTitle");
    const adminTeamCount = document.getElementById("adminTeamCount");
    const adminTotalSlots = document.getElementById("adminTotalSlots");
    const adminPatternCustom = document.getElementById("adminPatternCustom");
    const adminSaveEvent = document.getElementById("adminSaveEvent");
    const adminSettingMessage = document.getElementById("adminSettingMessage");
    const adminTeamNamesList = document.getElementById("adminTeamNamesList");
    const adminRegenerateMessage = document.getElementById("adminRegenerateMessage");
    const regenerateTeamNames = document.getElementById("regenerateTeamNames");
    const resetAssignments = document.getElementById("resetAssignments");
    const resetAll = document.getElementById("resetAll");

    const presetRadios = document.querySelectorAll('input[name="patternPreset"]');

    function syncFromTeamCountAndSlots() {
      const numTeams = parseInt(adminTeamCount.value, 10) || 0;
      const totalSlots = parseInt(adminTotalSlots.value, 10) || 0;
      if (numTeams < 1 || totalSlots < numTeams) return;
      const sizes = distributeSlots(numTeams, totalSlots);
      if (sizes.length) {
        adminPatternCustom.value = sizes.join(",");
        document.querySelector('input[name="patternPreset"][value="custom"]').checked = true;
      }
    }

    function syncToTeamCountAndSlots() {
      const pattern = parseCustomPattern(adminPatternCustom.value.trim());
      const checked = document.querySelector('input[name="patternPreset"]:checked');
      const p = pattern || (checked && checked.value !== "custom" && PRESETS[parseInt(checked.value, 10)] ? { teams: PRESETS[parseInt(checked.value, 10)].teams } : null);
      if (p?.teams?.length) {
        adminTeamCount.value = p.teams.length;
        adminTotalSlots.value = p.teams.reduce((s, t) => s + (t.size || 0), 0);
      }
    }

    adminTeamCount.addEventListener("change", syncFromTeamCountAndSlots);
    adminTotalSlots.addEventListener("change", syncFromTeamCountAndSlots);

    presetRadios.forEach((r) => {
      r.addEventListener("change", function () {
        if (this.value === "custom") adminPatternCustom.focus();
        else if (PRESETS[parseInt(this.value, 10)]) adminPatternCustom.value = patternToCustomString(PRESETS[parseInt(this.value, 10)].teams);
        syncToTeamCountAndSlots();
      });
    });
    adminPatternCustom.addEventListener("input", function () {
      const idx = PRESETS.findIndex((p) => patternToCustomString({ teams: p.teams }) === this.value.trim());
      if (idx >= 0) presetRadios[idx].checked = true;
      else document.querySelector('input[name="patternPreset"][value="custom"]').checked = true;
      syncToTeamCountAndSlots();
    });
    adminPatternCustom.addEventListener("change", syncToTeamCountAndSlots);

    function getPatternFromForm() {
      const checked = document.querySelector('input[name="patternPreset"]:checked');
      let pattern = null;
      if (checked && checked.value !== "custom") {
        const p = PRESETS[parseInt(checked.value, 10)];
        pattern = p ? { teams: p.teams.map((t) => ({ ...t })) } : null;
      } else {
        pattern = parseCustomPattern(adminPatternCustom.value.trim());
      }
      if (!pattern?.teams?.length) return null;
      const currentTeams = (event.pattern && event.pattern.teams) || [];
      pattern.teams = pattern.teams.map((t, i) => ({
        name: (currentTeams[i] && currentTeams[i].name) ? currentTeams[i].name : "",
        size: t.size,
      }));
      return pattern;
    }

    adminSaveEvent.addEventListener("click", async () => {
      const token = sessionStorage.getItem("admin_token_" + eventCode) || adminToken.value.trim();
      if (!token) {
        adminSettingMessage.textContent = "管理者トークンを先に入力してください";
        adminSettingMessage.style.display = "block";
        adminSettingMessage.style.color = "var(--c-danger)";
        return;
      }
      const title = adminEventTitle.value.trim().slice(0, 200);
      const pattern = getPatternFromForm();
      if (!pattern || !pattern.teams.length) {
        adminSettingMessage.textContent = "チーム構成を正しく入力してください（例: 4,4,5,5）";
        adminSettingMessage.style.display = "block";
        adminSettingMessage.style.color = "var(--c-danger)";
        return;
      }
      adminSettingMessage.style.display = "none";
      adminSaveEvent.disabled = true;
      try {
        const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Token": btoa(unescape(encodeURIComponent(token))),
          },
          body: JSON.stringify({ title, pattern }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          adminSettingMessage.textContent = data.error || "保存に失敗しました";
          adminSettingMessage.style.display = "block";
          adminSettingMessage.style.color = "var(--c-danger)";
          return;
        }
        showToast("イベント設定を保存しました");
        if (token) sessionStorage.setItem("admin_token_" + eventCode, token);
        loadStatus();
      } catch (e) {
        adminSettingMessage.textContent = e.message || "エラーが発生しました";
        adminSettingMessage.style.display = "block";
        adminSettingMessage.style.color = "var(--c-danger)";
      } finally {
        adminSaveEvent.disabled = false;
      }
    });

    function setMessage(msg, isError) {
      adminMessage.textContent = msg;
      adminMessage.style.display = msg ? "block" : "none";
      adminMessage.style.color = isError ? "var(--c-danger)" : "var(--c-success)";
    }

    function loadStatus() {
      fetchEvent(eventCode)
        .then((d) => {
          event.assigned_count = d.assigned_count;
          event.pattern = d.pattern;
          event.teams = d.teams;
          adminStatus.innerHTML = `参加 ${d.assigned_count || 0} / ${d.total_slots || 0}　残り枠 ${d.remaining_slots ?? 0}`;
          if (adminTeamNamesList) adminTeamNamesList.textContent = (d.teams || []).map((t) => t.name || "—").join("、") || "（未設定）";
          if (regenerateTeamNames) regenerateTeamNames.disabled = (d.assigned_count || 0) > 0;
        })
        .catch(() => {
          adminStatus.textContent = "イベントを取得できません";
        });
    }

    function updateTeamNamesList(teams) {
      if (adminTeamNamesList) {
        adminTeamNamesList.textContent = (teams || []).map((t) => t.name || "—").join("、") || "（未設定）";
      }
    }

    loadStatus();
    const adminPoll = setInterval(loadStatus, 2000);

    if (regenerateTeamNames) {
      regenerateTeamNames.addEventListener("click", async () => {
        const token = getToken();
        if (!token) {
          adminRegenerateMessage.textContent = "管理者トークンを先に入力してください";
          adminRegenerateMessage.style.display = "block";
          return;
        }
        adminRegenerateMessage.style.display = "none";
        regenerateTeamNames.disabled = true;
        try {
          const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}/admin/regenerate-team-names`, {
            method: "POST",
            headers: { "X-Admin-Token": btoa(unescape(encodeURIComponent(token))) },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            adminRegenerateMessage.textContent = data.error || "チーム名の再生成に失敗しました";
            adminRegenerateMessage.style.display = "block";
            return;
          }
          showToast("チーム名を再生成しました");
          if (data.pattern && data.pattern.teams) {
            event.pattern = data.pattern;
            updateTeamNamesList(data.pattern.teams);
          }
        } catch (e) {
          adminRegenerateMessage.textContent = e.message || "エラーが発生しました";
          adminRegenerateMessage.style.display = "block";
        } finally {
          regenerateTeamNames.disabled = (event.assigned_count || 0) > 0;
        }
      });
    }

    function getToken() {
      return sessionStorage.getItem("admin_token_" + eventCode) || adminToken.value.trim();
    }

    function setToken(t) {
      if (t) sessionStorage.setItem("admin_token_" + eventCode, t);
    }

    const savedToken = sessionStorage.getItem("admin_token_" + eventCode);
    if (savedToken) adminToken.placeholder = "（保存済み）";

    function showConfirmModal(title, body, confirmText, onConfirm) {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      const inputId = "confirmResetInput_" + Date.now();
      overlay.innerHTML = `
        <div class="modal">
          <p style="font-weight:600; margin:0 0 8px">${escapeHtml(title)}</p>
          <p style="margin:0; font-size:0.9rem; color:var(--c-text-muted)">${escapeHtml(body)}</p>
          <label for="${inputId}" style="margin-top:12px; display:block">「${escapeHtml(confirmText)}」と入力してください</label>
          <input type="text" id="${inputId}" class="confirm-input" placeholder="${escapeHtml(confirmText)}" autocomplete="off" />
          <div style="margin-top:16px; display:flex; gap:8px">
            <button type="button" id="modalCancel" class="secondary" style="flex:1">キャンセル</button>
            <button type="button" id="modalOk" style="flex:1" disabled>実行</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      const input = document.getElementById(inputId);
      const okBtn = document.getElementById("modalOk");
      const cancelBtn = document.getElementById("modalCancel");
      input.focus();
      input.addEventListener("input", function () {
        okBtn.disabled = this.value.trim() !== confirmText;
      });
      okBtn.addEventListener("click", () => {
        overlay.remove();
        onConfirm();
      });
      cancelBtn.addEventListener("click", () => overlay.remove());
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    }

    async function doReset(path, confirmMsg, successMsg, confirmText) {
      const token = getToken();
      if (!token) {
        setMessage("管理者トークンを入力してください", true);
        return;
      }
      if (!confirm(confirmMsg)) return;
      showConfirmModal("最終確認", "この操作は取り消せません。", confirmText, async () => {
        setMessage("");
        try {
          const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}/${path}`, {
            method: "POST",
            headers: { "X-Admin-Token": btoa(unescape(encodeURIComponent(token))) },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(data.error || "失敗しました", true);
            return;
          }
          showToast(successMsg);
          setToken(token);
          loadStatus();
        } catch (e) {
          setMessage(e.message || "エラーが発生しました", true);
        }
      });
    }

    resetAssignments.addEventListener("click", () => {
      doReset(
        "admin/reset-assignments",
        "割り当てだけをリセットします。参加者名は残ります。よろしいですか？",
        "割り当てをリセットしました",
        "RESET"
      );
    });

    resetAll.addEventListener("click", () => {
      doReset(
        "admin/reset-all",
        "参加者と割り当てをすべて削除します。取り消せません。よろしいですか？",
        "すべてリセットしました",
        "RESET"
      );
    });
  }

  function renderDisplayPage(eventCode, data) {
    const event = data;
    const joinUrl = window.location.origin + "/e/" + encodeURIComponent(eventCode);
    const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=" + encodeURIComponent(joinUrl);

    function update() {
      fetchEvent(eventCode).then((d) => {
        event.teams = d.teams;
        event.assigned_count = d.assigned_count;
        event.remaining_slots = d.remaining_slots;
        event.total_slots = d.total_slots;
        render();
      }).catch(() => {});
    }

    function render() {
      const teams = event.teams || [];
      const assigned = event.assigned_count || 0;
      const total = event.total_slots || 0;
      const remaining = event.remaining_slots ?? 0;
      document.getElementById("app").innerHTML = `
        <div class="container display-mode">
          <h1 class="pulse">${escapeHtml(event.title || "くじ引き")}</h1>
          <p class="subtitle">${escapeHtml(event.event_code)}　参加 ${assigned} / ${total} 名　残り枠 ${remaining}</p>
          <div class="qr-wrap card">
            <p style="margin:0 0 8px; font-weight:600">参加用URL</p>
            <img src="${escapeHtml(qrUrl)}" width="140" height="140" alt="QR" />
            <p style="margin:0; font-size:0.85rem; word-break:break-all; color:#666">${escapeHtml(joinUrl)}</p>
          </div>
          <div class="teams-grid" id="displayTeamsList"></div>
        </div>
      `;
      const list = document.getElementById("displayTeamsList");
      if (list) {
        const teamLabel = (name) => name ? `『${escapeHtml(name)}チーム』` : "チーム";
        list.innerHTML = teams.map((t) => `
          <div class="team-card">
            <h3>${teamLabel(t.name)}（${t.assigned}/${t.size}）</h3>
            <div class="members">${(t.members || []).map((m) => `<span>${escapeHtml(m)}</span>`).join("") || "—"}</div>
          </div>
        `).join("");
      }
    }

    render();
    const t = setInterval(update, 2000);
    window._displayPoll = t;
  }

  function renderHome() {
    document.getElementById("app").innerHTML = `
      <div class="container">
        <h1>チームくじ引き</h1>
        <p class="subtitle">イベントコードをURLで開いてください。</p>
        <p>例: <code>/e/SA2026</code></p>
      </div>
    `;
  }

  function escapeHtml(s) {
    if (s == null) return "";
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function init() {
    const path = getPath();
    const route = parseRoute(path);

    if (!route) {
      if (path === "/" || path === "/index.html") {
        renderHome();
      } else {
        document.getElementById("app").innerHTML = `
          <div class="container">
            <p class="loading">ページを読み込み中...</p>
          </div>
        `;
        const first = path.split("/").filter(Boolean)[1];
        if (first) {
          fetchEvent(first)
            .then((data) => renderParticipantPage(first, data))
            .catch((e) => {
              document.getElementById("app").innerHTML = `
                <div class="container">
                  <p class="error-msg">${escapeHtml(e.message)}</p>
                  <a href="/" class="nav-link">トップへ</a>
                </div>
              `;
            });
        } else {
          renderHome();
        }
      }
      return;
    }

    const { eventCode, mode } = route;

    if (mode === "admin") {
      document.getElementById("app").innerHTML = `<div class="container"><p class="loading">読み込み中...</p></div>`;
      fetchEvent(eventCode)
        .then((data) => renderAdminPage(eventCode, data))
        .catch((e) => {
          document.getElementById("app").innerHTML = `
            <div class="container">
              <p class="error-msg">${escapeHtml(e.message)}</p>
              <a href="/" class="nav-link">トップへ</a>
            </div>
          `;
        });
      return;
    }
    if (mode === "display") {
      fetchEvent(eventCode)
        .then((data) => renderDisplayPage(eventCode, data))
        .catch((e) => {
          document.getElementById("app").innerHTML = `
            <div class="container">
              <p class="error-msg">${escapeHtml(e.message)}</p>
              <a href="/" class="nav-link">トップへ</a>
            </div>
          `;
        });
      return;
    }

    document.getElementById("app").innerHTML = `
      <div class="container">
        <p class="loading">読み込み中...</p>
      </div>
    `;

    fetchEvent(eventCode)
      .then((data) => renderParticipantPage(eventCode, data))
      .catch((e) => {
        document.getElementById("app").innerHTML = `
          <div class="container">
            <p class="error-msg">${escapeHtml(e.message)}</p>
            <a href="/" class="nav-link">トップへ</a>
          </div>
        `;
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

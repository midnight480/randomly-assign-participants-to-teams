(function () {
  const API = "/api";
  const DEFAULT_EVENT_CODE = "JAWS-SAGA";

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function getPath() {
    return window.location.pathname;
  }

  function parseRoute(path) {
    const m = path.match(/^\/e\/([^/]+)(?:\/(admin|display))?\/?$/);
    if (m) {
      return { eventCode: m[1], mode: m[2] || "participant" };
    }
    if (path.startsWith("/admin")) {
      return { eventCode: DEFAULT_EVENT_CODE, mode: "admin" };
    }
    return { eventCode: DEFAULT_EVENT_CODE, mode: "participant" };
  }

  async function fetchEvent(eventCode) {
    const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || "イベントの取得に失敗しました");
    }
    return res.json();
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

  // --- Real-time AppSync Events Connection ---
  // AppSync Events の WebSocket は GraphQL 版と手順が違う:
  //   1. サブプロトコルに header-<base64url(認証ヘッダ)> を載せる
  //   2. connection_init を送って connection_ack を待つ
  //   3. subscribe を送る
  // connection_init を送らないとサーバ側でタイムアウトして切断される。
  function base64UrlEncode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function setupAppSyncRealtime(eventCode, onUpdate) {
    let retryDelay = 1000;
    let closed = false;

    fetch(`${API}/config`)
      .then((res) => res.json())
      .then((config) => {
        if (!config.appsyncRealtimeEndpoint || !config.appsyncApiKey) {
          console.log("AppSync Events 未設定のためポーリングのみで動作します");
          return;
        }

        const httpHost = String(config.appsyncHttpEndpoint || "")
          .replace(/^https?:\/\//, "")
          .replace(/\/+$/, "");
        const realtimeUrl =
          String(config.appsyncRealtimeEndpoint).replace(/\/+$/, "") + "/event/realtime";
        const channel = config.appsyncChannel || "/team-drawer/shuffle";
        const auth = { host: httpHost, "x-api-key": config.appsyncApiKey };

        function connect() {
          if (closed) return;

          let ws;
          try {
            ws = new WebSocket(realtimeUrl, [
              "aws-appsync-event-ws",
              `header-${base64UrlEncode(auth)}`,
            ]);
          } catch (err) {
            console.warn("AppSync WebSocket 生成に失敗:", err);
            return;
          }

          ws.onopen = () => {
            ws.send(JSON.stringify({ type: "connection_init" }));
          };

          ws.onmessage = (raw) => {
            let msg;
            try {
              msg = JSON.parse(raw.data);
            } catch (e) {
              return;
            }

            switch (msg.type) {
              case "connection_ack":
                retryDelay = 1000;
                ws.send(
                  JSON.stringify({
                    type: "subscribe",
                    id: "shuffle-sub",
                    channel: channel,
                    authorization: auth,
                  })
                );
                break;
              case "subscribe_success":
                console.log("AppSync Events 購読開始:", channel);
                break;
              case "subscribe_error":
              case "connection_error":
                console.warn("AppSync Events エラー:", raw.data);
                break;
              case "data":
                onUpdate();
                break;
              default:
                break; // ka (keepalive) など
            }
          };

          ws.onclose = () => {
            if (closed) return;
            // 指数バックオフで再接続（最大30秒）
            setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30000);
          };

          ws.onerror = () => ws.close();
        }

        connect();
        window.addEventListener("beforeunload", () => {
          closed = true;
        });
      })
      .catch(() => {});
  }

  // --- Render Participant View ---
  function renderParticipantPage(eventCode, data) {
    const event = data;
    const teams = event.teams || [];
    const totalSlots = event.total_slots || 0;
    const assigned = event.assigned_count || 0;

    let html = `
      <div class="container">
        <h1>${escapeHtml(event.title || "JAWS-UG佐賀 チーム割り当て")}</h1>
        <p class="subtitle">イベントコード: <strong>${escapeHtml(eventCode)}</strong></p>

        <div class="status-bar">
          <span>割り当て済み: <strong>${assigned}</strong> / ${totalSlots} 名</span>
          <span>チーム数: <strong>${teams.length}</strong></span>
        </div>

        <div class="card">
          <h2 style="font-size:1.2rem; margin:0 0 16px">🎯 チーム一覧＆結果</h2>
          <div class="teams-grid" id="teamsList"></div>
        </div>

        <div style="text-align:center; margin-top:20px;">
          <a href="/e/${encodeURIComponent(eventCode)}/admin" class="nav-link" style="display:inline-block; font-weight:bold; color:var(--c-primary)">⚙️ 管理画面（シャッフル実行・ログイン）</a>
        </div>
      </div>
    `;

    document.getElementById("app").innerHTML = html;

    function renderTeams() {
      const teamsList = document.getElementById("teamsList");
      if (!teamsList) return;

      if (teams.length === 0) {
        teamsList.innerHTML = `<p style="text-align:center; color:var(--c-text-muted); padding:20px;">管理者がシャッフルを実行すると、ここにチーム分け結果と佐賀弁のひとことが表示されます。</p>`;
        return;
      }

      teamsList.innerHTML = teams
        .map((t) => {
          const membersStr = (t.members || []).map((m) => `<span>${escapeHtml(m)}</span>`).join("");
          const commentStr = t.comment
            ? `<div class="ai-comment-badge"><span class="icon">✨</span><div><strong>ひとこと:</strong> ${escapeHtml(t.comment)}</div></div>`
            : "";

          return `
            <div class="team-card">
              <h3>${escapeHtml(t.name)} チーム（${(t.members || []).length} / ${t.size}名）</h3>
              <div class="members">${membersStr || "<span style='color:var(--c-text-muted)'>メンバー未割当</span>"}</div>
              ${commentStr}
            </div>
          `;
        })
        .join("");
    }

    renderTeams();

    // Setup polling (3s) + AppSync Realtime sync
    let pollTimer = setInterval(() => {
      fetchEvent(eventCode)
        .then((newData) => {
          event.teams = newData.teams;
          event.assigned_count = newData.assigned_count;
          event.total_slots = newData.total_slots;
          renderTeams();
        })
        .catch(() => {});
    }, 3000);

    setupAppSyncRealtime(eventCode, () => {
      fetchEvent(eventCode).then((newData) => {
        event.teams = newData.teams;
        event.assigned_count = newData.assigned_count;
        event.total_slots = newData.total_slots;
        renderTeams();
        showToast("🔔 チーム分け結果が更新されました！");
      });
    });
  }

  // --- Render Admin View ---
  function renderAdminPage(eventCode) {
    const adminToken = localStorage.getItem("admin_token");

    if (!adminToken) {
      renderLoginForm(eventCode);
      return;
    }

    let html = `
      <div class="container">
        <h1>⚙️ 管理者画面</h1>
        <p class="subtitle">Cognito 認証済み (${escapeHtml(eventCode)})</p>

        <div class="card admin-card">
          <h2 style="font-size:1.1rem; margin:0 0 12px">1. 参加者名の入力 (改行区切り)</h2>
          <textarea id="participantInput" class="textarea-names" placeholder="山田太郎&#10;佐藤花子&#10;佐賀次郎"></textarea>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <label for="teamCountInput" style="margin:0">チーム数:</label>
            <input type="number" id="teamCountInput" value="3" min="1" max="10" style="width:70px; padding:6px; font-size:1rem; border-radius:6px; border:1px solid var(--c-border)" />
          </div>

          <p id="adminError" class="error-msg" style="display:none; color:var(--c-danger); font-size:0.9rem; margin-bottom:12px;"></p>

          <button type="button" id="shuffleBtn" style="width:100%; font-weight:bold; padding:12px; font-size:1.05rem;">🎲 シャッフル実行</button>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <h2 style="font-size:1.1rem; margin:0">現在のチーム分け状況</h2>
            <button type="button" id="resetBtn" class="secondary" style="padding:6px 12px; font-size:0.85rem">リセット</button>
          </div>
          <div id="adminTeamsList" class="teams-grid"></div>
        </div>

        <div style="text-align:center; margin-top:20px; display:flex; gap:16px; justify-content:center;">
          <a href="/e/${encodeURIComponent(eventCode)}" class="nav-link">👥 参加者向け公開画面へ</a>
          <button type="button" id="logoutBtn" class="secondary" style="padding:6px 12px; font-size:0.85rem">ログアウト</button>
        </div>
      </div>
    `;

    document.getElementById("app").innerHTML = html;

    const participantInput = document.getElementById("participantInput");
    const teamCountInput = document.getElementById("teamCountInput");
    const shuffleBtn = document.getElementById("shuffleBtn");
    const resetBtn = document.getElementById("resetBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const adminError = document.getElementById("adminError");
    const adminTeamsList = document.getElementById("adminTeamsList");

    function loadCurrentState() {
      fetchEvent(eventCode)
        .then((data) => {
          if (data.participants && data.participants.length > 0 && !participantInput.value) {
            participantInput.value = data.participants.join("\n");
          }
          if (data.teams && data.teams.length > 0) {
            teamCountInput.value = data.teams.length;
          }
          renderAdminTeams(data.teams || []);
        })
        .catch(() => {});
    }

    function renderAdminTeams(teams) {
      if (teams.length === 0) {
        adminTeamsList.innerHTML = `<p style="color:var(--c-text-muted)">まだチーム分けが実行されていません。</p>`;
        return;
      }
      adminTeamsList.innerHTML = teams
        .map(
          (t) => `
        <div class="team-card">
          <h3>${escapeHtml(t.name)} チーム (${(t.members || []).length} / ${t.size}名)</h3>
          <div class="members">${(t.members || []).map((m) => `<span>${escapeHtml(m)}</span>`).join("") || "—"}</div>
          ${t.comment ? `<div class="ai-comment-badge"><span class="icon">✨</span><div>${escapeHtml(t.comment)}</div></div>` : ""}
        </div>
      `
        )
        .join("");
    }

    loadCurrentState();

    shuffleBtn.addEventListener("click", async () => {
      adminError.style.display = "none";
      const text = participantInput.value.trim();
      const names = text.split("\n").map((s) => s.trim()).filter(Boolean);

      if (names.length === 0) {
        adminError.textContent = "参加者名を1名以上入力してください。";
        adminError.style.display = "block";
        return;
      }

      const teamCount = parseInt(teamCountInput.value, 10) || 3;

      shuffleBtn.disabled = true;
      shuffleBtn.textContent = "⏳ シャッフル中...";

      try {
        const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}/admin/shuffle`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            participant_names: names,
            team_count: teamCount,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "シャッフルに失敗しました");
        }

        showToast("✨ チーム分けが完了しました！");
        renderAdminTeams(data.teams || []);
      } catch (err) {
        adminError.textContent = err.message;
        adminError.style.display = "block";
      } finally {
        shuffleBtn.disabled = false;
        shuffleBtn.textContent = "🎲 シャッフル実行";
      }
    });

    resetBtn.addEventListener("click", async () => {
      if (!confirm("チーム分け結果をリセットしますか？")) return;
      try {
        await fetch(`${API}/events/${encodeURIComponent(eventCode)}/admin/reset`, {
          method: "POST",
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        showToast("リセットしました");
        loadCurrentState();
      } catch (e) {
        alert("リセットに失敗しました");
      }
    });

    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem("admin_token");
      renderAdminPage(eventCode);
    });
  }

  // --- Cognito Admin Login Form ---
  function renderLoginForm(eventCode) {
    let html = `
      <div class="container">
        <h1>🔒 管理者ログイン</h1>
        <p class="subtitle">Cognito ユーザープール認証</p>

        <div class="card">
          <form id="loginForm">
            <label for="adminEmail">メールアドレス / ユーザー名</label>
            <input type="text" id="adminEmail" placeholder="admin@jaws-ug-saga.local" required style="width:100%; padding:10px; margin-bottom:12px; border-radius:6px; border:1px solid var(--c-border)" />

            <label for="adminPassword">パスワード</label>
            <input type="password" id="adminPassword" placeholder="••••••••" required style="width:100%; padding:10px; margin-bottom:16px; border-radius:6px; border:1px solid var(--c-border)" />

            <p id="loginError" class="error-msg" style="display:none; color:var(--c-danger); margin-bottom:12px;"></p>

            <button type="submit" id="loginBtn" style="width:100%; font-weight:bold; padding:12px;">ログイン</button>
          </form>
        </div>

        <div style="text-align:center; margin-top:16px;">
          <a href="/e/${encodeURIComponent(eventCode)}" class="nav-link">👥 参加者向け公開画面へ戻る</a>
        </div>
      </div>
    `;

    document.getElementById("app").innerHTML = html;

    const form = document.getElementById("loginForm");
    const loginError = document.getElementById("loginError");
    const loginBtn = document.getElementById("loginBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginError.style.display = "none";

      const email = document.getElementById("adminEmail").value.trim();
      const password = document.getElementById("adminPassword").value;

      loginBtn.disabled = true;
      loginBtn.textContent = "ログイン中...";

      try {
        const res = await fetch(`${API}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "ログインに失敗しました");
        }

        localStorage.setItem("admin_token", data.token);
        showToast("ログイン成功");
        renderAdminPage(eventCode);
      } catch (err) {
        loginError.textContent = err.message;
        loginError.style.display = "block";
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "ログイン";
      }
    });
  }

  // Initial Route Handler
  async function init() {
    const route = parseRoute(getPath());
    const eventCode = route.eventCode;

    if (route.mode === "admin") {
      renderAdminPage(eventCode);
    } else {
      try {
        const eventData = await fetchEvent(eventCode);
        renderParticipantPage(eventCode, eventData);
      } catch (e) {
        renderParticipantPage(eventCode, {
          event_code: eventCode,
          title: "JAWS-UG佐賀 チーム割り当て",
          teams: [],
        });
      }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

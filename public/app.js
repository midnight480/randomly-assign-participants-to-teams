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

    // 通知の受信を 1 秒に 1 回までに制限する（末尾の通知は取りこぼさない）
    let lastRun = 0;
    let pendingTimer = null;
    function throttledUpdate() {
      const wait = Math.max(0, 1000 - (Date.now() - lastRun));
      if (wait === 0) {
        lastRun = Date.now();
        onUpdate();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          lastRun = Date.now();
          onUpdate();
        }, wait);
      }
    }

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
                // AppSync の API キーは /api/config で公開されるため、第三者も
                // publish できる。通知を受けるたび無条件に再取得すると連打で
                // バックエンドを叩かされるので、1秒に1回までに絞る。
                throttledUpdate();
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

  // 自分の表示名（端末に保存して「自分のチーム」を強調表示するのに使う）
  function myName() {
    try {
      return localStorage.getItem("display_name") || "";
    } catch (e) {
      return "";
    }
  }
  function setMyName(name) {
    try {
      localStorage.setItem("display_name", name);
    } catch (e) {}
  }

  // --- Render Participant View ---
  function renderParticipantPage(eventCode, data) {
    const event = data;

    const html = `
      <div class="container">
        <h1>${escapeHtml(event.title || "JAWS-UG佐賀 チーム割り当て")}</h1>
        <p class="subtitle">イベントコード: <strong>${escapeHtml(eventCode)}</strong></p>

        <div class="card" id="joinCard"></div>

        <div class="status-bar">
          <span>参加者: <strong id="participantCount">0</strong> 名</span>
          <span>チーム数: <strong id="teamCount">0</strong></span>
        </div>

        <div class="card">
          <h2 style="font-size:1.2rem; margin:0 0 16px">🎯 チーム一覧＆結果</h2>
          <div class="teams-grid" id="teamsList"></div>
        </div>

        <div style="text-align:center; margin-top:20px; display:flex; gap:16px; justify-content:center; flex-wrap:wrap;">
          <a href="/e/${encodeURIComponent(eventCode)}/display" class="nav-link">📺 会場表示モード（QR）</a>
          <a href="/e/${encodeURIComponent(eventCode)}/admin" class="nav-link">⚙️ 管理画面</a>
        </div>
      </div>
    `;

    document.getElementById("app").innerHTML = html;

    // --- 参加登録フォーム ---
    // 3秒ごとの自動更新でフォームを作り直すと、入力途中の文字とフォーカスが
    // 消えてしまう。状態（未登録／登録済み）が変わったときだけ描き直す。
    let joinCardState = null;

    function renderJoinCard() {
      const card = document.getElementById("joinCard");
      if (!card) return;

      const name = myName();
      const joined = !!name && (event.participants || []).indexOf(name) !== -1;
      const currentTeam = joined
        ? ((event.teams || []).find((t) => (t.members || []).indexOf(name) !== -1) || {}).name || ""
        : "";
      const nextState = joined ? `joined:${name}:${currentTeam}` : "form";
      if (nextState === joinCardState) return;
      joinCardState = nextState;

      if (joined) {
        const myTeam = (event.teams || []).find(
          (t) => (t.members || []).indexOf(name) !== -1
        );
        const teamBlock = myTeam
          ? `<div class="result-card" style="margin:12px 0">
               <p class="label" style="margin:0 0 4px">${escapeHtml(name)} さんは</p>
               <p style="margin:0; font-size:1.6rem; font-weight:800; color:var(--c-primary)">${escapeHtml(myTeam.name)} チーム</p>
               ${myTeam.comment ? `<p style="margin:8px 0 0; font-size:0.95rem">✨ ${escapeHtml(myTeam.comment)}</p>` : ""}
             </div>`
          : `<p style="margin:0 0 8px">✅ <strong>${escapeHtml(name)}</strong> さんで参加済みです。</p>`;

        card.innerHTML = `
          ${teamBlock}
          <p style="margin:0; color:var(--c-text-muted); font-size:0.9rem">
            この画面は開いたままにしてください。チーム構成が変わると自動で更新されます。
          </p>
          <button type="button" id="changeNameBtn" class="secondary" style="margin-top:12px; padding:6px 12px; font-size:0.85rem">名前を変更する</button>
        `;
        const btn = document.getElementById("changeNameBtn");
        if (btn) {
          btn.addEventListener("click", () => {
            setMyName("");
            joinCardState = null; // 明示操作なので即座に描き直す
            renderJoinCard();
          });
        }
        return;
      }

      card.innerHTML = `
        <h2 style="font-size:1.1rem; margin:0 0 12px">名前を入れて、くじを引いてください</h2>
        <label for="joinName">表示名（氏名・ニックネーム）</label>
        <input type="text" id="joinName" maxlength="30" placeholder="例）しばお / 佐賀太郎"
               style="width:100%; padding:10px; margin-bottom:12px; border-radius:6px; border:1px solid var(--c-border)" />
        <p id="joinError" class="error-msg" style="display:none; color:var(--c-danger); font-size:0.9rem; margin-bottom:12px;"></p>
        <button type="button" id="joinBtn" style="width:100%; font-weight:bold; padding:12px; font-size:1.05rem;">🎲 くじを引く</button>
      `;

      const input = document.getElementById("joinName");
      const btn = document.getElementById("joinBtn");
      const err = document.getElementById("joinError");
      if (name) input.value = name;

      async function submit() {
        const value = input.value.trim().replace(/\s+/g, " ");
        if (!value) {
          err.textContent = "名前を入力してください。";
          err.style.display = "block";
          return;
        }
        err.style.display = "none";
        btn.disabled = true;
        btn.textContent = "🎲 抽選中...";
        try {
          const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}/draw`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ display_name: value }),
          });
          const d = await res.json();
          if (!res.ok) throw new Error(d.error || "くじ引きに失敗しました");

          setMyName(value);
          showToast(
            d.already_assigned
              ? `すでに ${d.team_name} チームです`
              : `🎉 ${d.team_name} チームに決まりました！`
          );
          await refresh();
        } catch (e) {
          err.textContent = e.message;
          err.style.display = "block";
        } finally {
          btn.disabled = false;
          btn.textContent = "🎲 くじを引く";
        }
      }

      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    }

    function renderTeams() {
      const teamsList = document.getElementById("teamsList");
      if (!teamsList) return;

      const teams = event.teams || [];
      document.getElementById("participantCount").textContent = (event.participants || []).length;
      document.getElementById("teamCount").textContent = teams.length;

      if (teams.length === 0) {
        teamsList.innerHTML = `<p style="text-align:center; color:var(--c-text-muted); padding:20px;">まだ誰もくじを引いていません。名前を入れて「くじを引く」を押すと、ここに結果が表示されます。</p>`;
        return;
      }

      const me = myName();

      teamsList.innerHTML = teams
        .map((t) => {
          const members = t.members || [];
          const mine = me && members.indexOf(me) !== -1;
          const membersStr = members
            .map((m) => `<span${m === me ? ' style="font-weight:700; text-decoration:underline"' : ""}>${escapeHtml(m)}</span>`)
            .join("");
          const commentStr = t.comment
            ? `<div class="ai-comment-badge"><span class="icon">✨</span><div><strong>ひとこと:</strong> ${escapeHtml(t.comment)}</div></div>`
            : "";

          return `
            <div class="team-card"${mine ? ' style="outline:2px solid var(--c-primary); outline-offset:2px"' : ""}>
              <h3>${escapeHtml(t.name)} チーム（${members.length}名）${mine ? " ← あなた" : ""}</h3>
              <div class="members">${membersStr || "<span style='color:var(--c-text-muted)'>まだ誰もいません</span>"}</div>
              ${commentStr}
            </div>
          `;
        })
        .join("");
    }

    async function refresh() {
      try {
        const newData = await fetchEvent(eventCode);
        event.teams = newData.teams;
        event.participants = newData.participants;
        event.assigned_count = newData.assigned_count;
        event.total_slots = newData.total_slots;
        renderJoinCard();
        renderTeams();
      } catch (e) {}
    }

    renderJoinCard();
    renderTeams();

    setInterval(refresh, 3000);

    setupAppSyncRealtime(eventCode, () => {
      refresh().then(() => showToast("🔔 チーム分け結果が更新されました！"));
    });
  }

  // --- Render Venue Display View (TV / プロジェクター用) ---
  function renderDisplayPage(eventCode, data) {
    const event = data;
    const joinUrl = window.location.origin + "/e/" + encodeURIComponent(eventCode);
    // QR は外部サービスで生成する（main ブランチと同じ方式）。
    // 読み込めなかった場合に備えて URL も大きく表示している。
    const qrUrl =
      "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" +
      encodeURIComponent(joinUrl);

    document.body.classList.add("display-mode");

    function render() {
      const teams = event.teams || [];
      const participants = event.participants || [];

      document.getElementById("app").innerHTML = `
        <div class="container">
          <h1 class="pulse">${escapeHtml(event.title || "JAWS-UG佐賀 チーム割り当て")}</h1>
          <p class="subtitle">イベントコード: <strong>${escapeHtml(eventCode)}</strong>　参加者 ${participants.length} 名　チーム ${teams.length}</p>

          <div class="qr-wrap card">
            <p style="margin:0 0 8px; font-weight:700; font-size:1.1rem">スマホで読み取って、くじを引いてください</p>
            <img src="${escapeHtml(qrUrl)}" width="220" height="220" alt="参加用QRコード"
                 onerror="this.style.display='none'" />
            <p style="margin:8px 0 0; font-size:1rem; word-break:break-all;">${escapeHtml(joinUrl)}</p>
          </div>

          <div class="teams-grid" id="displayTeams"></div>
        </div>
      `;

      const list = document.getElementById("displayTeams");
      if (!list) return;

      if (teams.length === 0) {
        list.innerHTML = `<p style="text-align:center; color:var(--c-text-muted); padding:20px;">まだ誰もくじを引いていません。QRを読み取って名前を入れると、ここに表示されます。</p>`;
        return;
      }

      list.innerHTML = teams
        .map((t) => {
          const members = (t.members || []).map((m) => `<span>${escapeHtml(m)}</span>`).join("");
          const comment = t.comment
            ? `<div class="ai-comment-badge"><span class="icon">✨</span><div>${escapeHtml(t.comment)}</div></div>`
            : "";
          return `
            <div class="team-card">
              <h3>${escapeHtml(t.name)} チーム（${(t.members || []).length}名）</h3>
              <div class="members">${members || "—"}</div>
              ${comment}
            </div>
          `;
        })
        .join("");
    }

    async function refresh() {
      try {
        const d = await fetchEvent(eventCode);
        event.teams = d.teams;
        event.participants = d.participants;
        event.title = d.title;
        render();
      } catch (e) {}
    }

    render();
    setInterval(refresh, 3000);
    setupAppSyncRealtime(eventCode, () => {
      refresh().then(() => showToast("🔔 チーム分け結果が更新されました！"));
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
          <h2 style="font-size:1.1rem; margin:0 0 8px">参加者リスト</h2>
          <p style="margin:0 0 12px; color:var(--c-text-muted); font-size:0.85rem">
            参加者が自分でくじを引くと自動で追加されます。ここを編集して引き直すこともできます（改行区切り）。
          </p>
          <textarea id="participantInput" class="textarea-names" placeholder="山田太郎&#10;佐藤花子&#10;佐賀次郎"></textarea>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <label for="teamCountInput" style="margin:0">チーム数:</label>
            <input type="number" id="teamCountInput" value="3" min="1" max="10" style="width:70px; padding:6px; font-size:1rem; border-radius:6px; border:1px solid var(--c-border)" />
          </div>

          <p id="adminError" class="error-msg" style="display:none; color:var(--c-danger); font-size:0.9rem; margin-bottom:12px;"></p>

          <button type="button" id="shuffleBtn" style="width:100%; font-weight:bold; padding:12px; font-size:1.05rem;">🎲 全員を引き直す</button>
          <p style="margin:8px 0 0; color:var(--c-text-muted); font-size:0.8rem">
            ※ 全員のチームが変わります。通常の運用では不要です。
          </p>
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
          <h3>${escapeHtml(t.name)} チーム (${(t.members || []).length}名)</h3>
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
      shuffleBtn.textContent = "⏳ 引き直し中...";

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
        shuffleBtn.textContent = "🎲 全員を引き直す";
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
            <input type="text" id="adminEmail" placeholder="admin@example.com" required style="width:100%; padding:10px; margin-bottom:12px; border-radius:6px; border:1px solid var(--c-border)" />

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
      return;
    }

    const fallback = {
      event_code: eventCode,
      title: "JAWS-UG佐賀 チーム割り当て",
      teams: [],
      participants: [],
    };

    let eventData = fallback;
    try {
      eventData = await fetchEvent(eventCode);
    } catch (e) {}

    if (route.mode === "display") {
      renderDisplayPage(eventCode, eventData);
    } else {
      renderParticipantPage(eventCode, eventData);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();

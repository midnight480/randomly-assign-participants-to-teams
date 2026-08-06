(function () {
  const API = "/api";
  // サーバ (/api/config) から取得できなかったときだけ使うフォールバック。
  // 通常はデプロイ時の EVENT_CODE / EVENT_TITLE がそのまま使われるので、
  // ここにイベント固有の名前は置かない。
  let DEFAULT_EVENT_CODE = "";
  let DEFAULT_TITLE = "チーム割り当て";

  // /api/config は起動時とリアルタイム購読の両方で使うので一度だけ取得する
  let configPromise = null;
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch(`${API}/config`)
        .then((res) => res.json())
        .catch(() => ({}));
    }
    return configPromise;
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

    getConfig()
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
        <h1>${escapeHtml(event.title || DEFAULT_TITLE)}</h1>
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
          <h1 class="pulse">${escapeHtml(event.title || DEFAULT_TITLE)}</h1>
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
          <h2 style="font-size:1.1rem; margin:0 0 8px">チーム構成</h2>
          <p style="margin:0 0 12px; color:var(--c-text-muted); font-size:0.85rem">
            チーム数とチーム名を変更できます。<strong>引き直しはしません</strong>ので、すでにくじを引いた人のチームはそのままです。
            名前を空欄にすると佐賀弁から自動で付けます。
          </p>

          <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap;">
            <label for="teamCountInput" style="margin:0">チーム数:</label>
            <input type="number" id="teamCountInput" value="4" min="1" max="20" style="width:70px; padding:6px; font-size:1rem; border-radius:6px; border:1px solid var(--c-border)" />
            <button type="button" id="clearNamesBtn" class="secondary" style="width:auto; padding:6px 12px; font-size:0.85rem">名前をクリア（自動命名）</button>
          </div>

          <div id="teamNameInputs" class="team-name-inputs"></div>

          <p id="teamConfigError" class="error-msg" style="display:none; color:var(--c-danger); font-size:0.9rem; margin-bottom:12px;"></p>

          <button type="button" id="applyTeamsBtn" style="width:100%; font-weight:bold; padding:12px; font-size:1.05rem;">💾 チーム構成を反映する</button>
          <p style="margin:8px 0 0; color:var(--c-text-muted); font-size:0.8rem">
            ※ チーム数を減らすと、あふれた人は人数の少ないチームへ移ります。増やしたぶんは空のまま、次にくじを引いた人から入ります。
          </p>
        </div>

        <div class="card admin-card">
          <h2 style="font-size:1.1rem; margin:0 0 8px">参加者リスト</h2>
          <p style="margin:0 0 12px; color:var(--c-text-muted); font-size:0.85rem">
            参加者が自分でくじを引くと自動で追加されます。ここを編集して引き直すこともできます（改行区切り）。
          </p>
          <textarea id="participantInput" class="textarea-names" placeholder="山田太郎&#10;佐藤花子&#10;佐賀次郎"></textarea>

          <p id="adminError" class="error-msg" style="display:none; color:var(--c-danger); font-size:0.9rem; margin-bottom:12px;"></p>

          <button type="button" id="shuffleBtn" style="width:100%; font-weight:bold; padding:12px; font-size:1.05rem;">🎲 全員を引き直す</button>
          <p style="margin:8px 0 0; color:var(--c-text-muted); font-size:0.8rem">
            ※ 全員のチームが変わります（上で指定したチーム数・チーム名を使います）。通常の運用では不要です。
          </p>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
            <h2 style="font-size:1.1rem; margin:0">現在のチーム分け状況</h2>
            <div style="display:flex; gap:8px;">
              <button type="button" id="clearParticipantsBtn" class="secondary" style="width:auto; padding:6px 12px; font-size:0.85rem">参加者を全員削除</button>
              <button type="button" id="resetBtn" class="secondary" style="width:auto; padding:6px 12px; font-size:0.85rem">リセット</button>
            </div>
          </div>
          <p style="margin:0 0 12px; color:var(--c-text-muted); font-size:0.85rem">
            名前の <strong>✕</strong> でその人だけ削除できます。「全員削除」はチーム名・チーム数を残したまま参加者だけ消します。
            「リセット」はチーム分けごと消します（チーム名も消えます）。
          </p>
          <div id="unassignedWrap" style="display:none; margin-bottom:12px;">
            <p style="margin:0 0 6px; font-size:0.9rem; color:var(--c-text-muted)">まだチームに入っていない参加者</p>
            <div id="unassignedList" class="members"></div>
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
    const clearParticipantsBtn = document.getElementById("clearParticipantsBtn");
    const unassignedWrap = document.getElementById("unassignedWrap");
    const unassignedList = document.getElementById("unassignedList");
    const logoutBtn = document.getElementById("logoutBtn");
    const adminError = document.getElementById("adminError");
    const adminTeamsList = document.getElementById("adminTeamsList");
    const teamNameInputs = document.getElementById("teamNameInputs");
    const applyTeamsBtn = document.getElementById("applyTeamsBtn");
    const clearNamesBtn = document.getElementById("clearNamesBtn");
    const teamConfigError = document.getElementById("teamConfigError");

    // --- チーム構成（チーム数・チーム名）---------------------------------
    // 参加者リストと同じく、サーバの値へ自動で追従させたいが、
    // 管理者が編集を始めたら上書きしない。
    let teamConfigEdited = false;

    function currentTeamCount() {
      const n = parseInt(teamCountInput.value, 10);
      if (!n || n < 1) return 1;
      return Math.min(n, 20);
    }

    function readTeamNames() {
      return Array.from(teamNameInputs.querySelectorAll("input")).map((el) =>
        el.value.trim()
      );
    }

    /** count 行ぶんの入力欄を作る。すでに入っている値は残す。 */
    function renderTeamNameInputs(count, values) {
      const kept = values || readTeamNames();
      const focusedIndex = Array.from(teamNameInputs.querySelectorAll("input")).indexOf(
        document.activeElement
      );

      teamNameInputs.innerHTML = Array.from({ length: count }, (_, i) => {
        const value = kept[i] || "";
        return `
          <div class="team-name-row">
            <label for="teamName${i}">${i + 1}</label>
            <input type="text" id="teamName${i}" maxlength="20" value="${escapeHtml(value)}"
                   placeholder="（空欄で佐賀弁から自動命名）" />
          </div>
        `;
      }).join("");

      teamNameInputs.querySelectorAll("input").forEach((el) => {
        el.addEventListener("input", () => {
          teamConfigEdited = true;
        });
      });

      if (focusedIndex >= 0) {
        const next = teamNameInputs.querySelectorAll("input")[focusedIndex];
        if (next) next.focus();
      }
    }

    teamCountInput.addEventListener("input", () => {
      teamConfigEdited = true;
      // 入力途中で全消しされた瞬間に1行へ潰さない
      if (teamCountInput.value.trim() === "") return;
      if (currentTeamCount() !== parseInt(teamCountInput.value, 10)) {
        teamCountInput.value = currentTeamCount(); // 1〜20 に収める
      }
      renderTeamNameInputs(currentTeamCount());
    });

    clearNamesBtn.addEventListener("click", () => {
      teamConfigEdited = true;
      renderTeamNameInputs(currentTeamCount(), []);
    });

    /** サーバの現状をチーム構成の入力欄へ反映する（編集中は触らない） */
    function syncTeamConfig(teams) {
      if (teamConfigEdited) return;
      if (teamNameInputs.contains(document.activeElement)) return;
      if (document.activeElement === teamCountInput) return;
      if (!teams || teams.length === 0) return;

      teamCountInput.value = teams.length;
      renderTeamNameInputs(teams.length, teams.map((t) => t.name));
    }

    renderTeamNameInputs(currentTeamCount(), []);

    // 「全員を引き直す」はテキストエリアの内容でサーバ側の参加者を置き換える。
    // 開いた時点のリストを持ち続けると、その後にくじを引いた人が引き直しで消える。
    // そのため定期的にサーバの値へ追従させる。ただし管理者が手で編集した場合と
    // 入力中（フォーカス中）は上書きしない。
    let lastServerList = "";

    function loadCurrentState() {
      fetchEvent(eventCode)
        .then((data) => {
          const serverList = (data.participants || []).join("\n");
          const edited =
            participantInput.value.trim() !== "" &&
            participantInput.value !== lastServerList;

          if (!edited && document.activeElement !== participantInput) {
            participantInput.value = serverList;
          }
          lastServerList = serverList;

          syncTeamConfig(data.teams || []);
          renderAdminTeams(data.teams || [], data.participants || []);
        })
        .catch(() => {});
    }

    /** 削除ボタン付きの参加者バッジ */
    function memberChip(name) {
      return `<span class="member-chip">${escapeHtml(name)}<button type="button" class="member-del"
        data-name="${escapeHtml(name)}" title="${escapeHtml(name)} を削除" aria-label="${escapeHtml(name)} を削除">✕</button></span>`;
    }

    function renderAdminTeams(teams, participants) {
      // くじを引かずに参加者リストにだけ載っている人（管理者が手で足した場合など）
      const assigned = new Set(teams.flatMap((t) => t.members || []));
      const unassigned = (participants || []).filter((p) => !assigned.has(p));
      unassignedWrap.style.display = unassigned.length > 0 ? "block" : "none";
      unassignedList.innerHTML = unassigned.map(memberChip).join("");

      if (teams.length === 0) {
        adminTeamsList.innerHTML = `<p style="color:var(--c-text-muted)">まだチーム分けが実行されていません。</p>`;
        return;
      }
      adminTeamsList.innerHTML = teams
        .map(
          (t) => `
        <div class="team-card">
          <h3>${escapeHtml(t.name)} チーム (${(t.members || []).length}名)</h3>
          <div class="members">${(t.members || []).map(memberChip).join("") || "—"}</div>
          ${t.comment ? `<div class="ai-comment-badge"><span class="icon">✨</span><div>${escapeHtml(t.comment)}</div></div>` : ""}
        </div>
      `
        )
        .join("");
    }

    /** 参加者を削除する（個別）。3秒ごとの再描画でボタンが作り直されるため委譲で拾う */
    async function removeParticipant(name) {
      if (!confirm(`${name} さんを削除しますか？`)) return;
      try {
        const res = await fetch(
          `${API}/events/${encodeURIComponent(eventCode)}/admin/remove-participants`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({ names: [name] }),
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "削除に失敗しました");

        showToast(data.message || `${name} さんを削除しました`);
        renderAdminTeams(data.teams || [], data.participants || []);
        loadCurrentState();
      } catch (err) {
        alert(err.message);
      }
    }

    function onDeleteClick(e) {
      const btn = e.target.closest(".member-del");
      if (!btn) return;
      removeParticipant(btn.dataset.name);
    }
    adminTeamsList.addEventListener("click", onDeleteClick);
    unassignedList.addEventListener("click", onDeleteClick);

    loadCurrentState();
    // 開場中は参加者が増え続けるので、管理画面も自動で追従させる
    setInterval(loadCurrentState, 3000);

    applyTeamsBtn.addEventListener("click", async () => {
      teamConfigError.style.display = "none";
      const count = currentTeamCount();
      const names = readTeamNames();

      applyTeamsBtn.disabled = true;
      applyTeamsBtn.textContent = "⏳ 反映中...";

      try {
        const res = await fetch(`${API}/events/${encodeURIComponent(eventCode)}/admin/teams`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ team_count: count, team_names: names }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "チーム構成の更新に失敗しました");

        showToast(data.message || "チーム構成を更新しました");
        // 自動命名された名前をそのまま入力欄へ戻す
        teamConfigEdited = false;
        renderTeamNameInputs(
          (data.teams || []).length,
          (data.teams || []).map((t) => t.name)
        );
        loadCurrentState(); // 参加者リストも含めて描き直す
      } catch (err) {
        teamConfigError.textContent = err.message;
        teamConfigError.style.display = "block";
      } finally {
        applyTeamsBtn.disabled = false;
        applyTeamsBtn.textContent = "💾 チーム構成を反映する";
      }
    });

    shuffleBtn.addEventListener("click", async () => {
      adminError.style.display = "none";
      const text = participantInput.value.trim();
      const names = text.split("\n").map((s) => s.trim()).filter(Boolean);

      if (names.length === 0) {
        adminError.textContent = "参加者名を1名以上入力してください。";
        adminError.style.display = "block";
        return;
      }

      // 引き直しでも、上のチーム構成で指定した数と名前をそのまま使う
      const teamCount = currentTeamCount();
      const teamNames = readTeamNames();

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
            team_names: teamNames,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "シャッフルに失敗しました");
        }

        showToast("✨ チーム分けが完了しました！");
        teamConfigEdited = false;
        renderTeamNameInputs(
          (data.teams || []).length,
          (data.teams || []).map((t) => t.name)
        );
        loadCurrentState(); // 参加者リストも含めて描き直す
      } catch (err) {
        adminError.textContent = err.message;
        adminError.style.display = "block";
      } finally {
        shuffleBtn.disabled = false;
        shuffleBtn.textContent = "🎲 全員を引き直す";
      }
    });

    clearParticipantsBtn.addEventListener("click", async () => {
      if (!confirm("参加者を全員削除しますか？（チーム名・チーム数は残ります）")) return;
      clearParticipantsBtn.disabled = true;
      try {
        const res = await fetch(
          `${API}/events/${encodeURIComponent(eventCode)}/admin/clear-participants`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` },
          }
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "削除に失敗しました");

        showToast(data.message || "参加者を全員削除しました");
        loadCurrentState();
      } catch (err) {
        alert(err.message);
      } finally {
        clearParticipantsBtn.disabled = false;
      }
    });

    resetBtn.addEventListener("click", async () => {
      if (!confirm("チーム分け結果をリセットしますか？（チーム名も消えます）")) return;
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
    // デプロイ時の EVENT_CODE / EVENT_TITLE を採用する。
    // URL に /e/{code} があればコードはそちらが優先。
    const config = await getConfig();
    if (config.eventCode) DEFAULT_EVENT_CODE = config.eventCode;
    if (config.title) DEFAULT_TITLE = config.title;
    document.title = `くじ引き - ${DEFAULT_TITLE}`;

    const route = parseRoute(getPath());
    const eventCode = route.eventCode;

    if (route.mode === "admin") {
      renderAdminPage(eventCode);
      return;
    }

    const fallback = {
      event_code: eventCode,
      title: DEFAULT_TITLE,
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

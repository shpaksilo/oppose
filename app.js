(() => {
  'use strict';

  /* ============================================================
     1. Supabase + LiveKit init
     ============================================================ */
  const SUPABASE_URL = 'https://gjyuudqxbimumpnsesky.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_Q9Y4HCWbc-_tG3-32GB0PQ_x9sYJIIF';
  const LIVEKIT_URL = 'wss://oppose-nywikotg.livekit.cloud';
  const LIVEKIT_TOKEN_FUNCTION_URL = 'https://gjyuudqxbimumpnsesky.supabase.co/functions/v1/get-livekit-token';

  let sb = null;
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[OPPOSE] Supabase client initialized:', SUPABASE_URL);
  } catch (err) {
    console.error('[OPPOSE] Failed to initialize Supabase client:', err);
  }

  // The livekit-client UMD bundle exposes itself as `LivekitClient` on window
  // (Room becomes LivekitClient.Room, RoomEvent becomes LivekitClient.RoomEvent, etc).
  const LK = window.LivekitClient || null;
  if (!LK) {
    console.error('[OPPOSE] LiveKit SDK (LivekitClient) not found on window — check the <script> tag.');
  } else {
    console.log('[OPPOSE] LiveKit SDK loaded.');
  }

  const QUEUE_TABLE = 'matchmaking_queue';
  const SEARCH_TIMEOUT_MS = 30000;
  const RING_ENTRY_GRACE_MS = 5000; // ignore ParticipantDisconnected noise right after joining

  /* ============================================================
     2. User identity (persisted in localStorage)
     ============================================================ */
  function getUserId() {
    let id = localStorage.getItem('userId');
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'user-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('userId', id);
      console.log('[OPPOSE] No userId in localStorage — generated a new one:', id);
    } else {
      console.log('[OPPOSE] Loaded existing userId from localStorage:', id);
    }
    return id;
  }

  function generateRoomId() {
    const rand = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return `room_${rand}`;
  }

  /* ============================================================
     State
     ============================================================ */
  const state = {
    userId: getUserId(),
    elo: 1000,
    category: 'light',
    searchTimer: null,
    searchSeconds: 0,
    matchTimeout: null,
    phaseIndex: 0,
    phaseRemaining: 0,
    phaseTimer: null,
    hintTimer: null,
    role: 'ЗА',
    queueChannel: null,
    roomId: null,
    myQueueRowId: null,
    ringEntered: false,
    livekitRoom: null,
    roomConnectedAt: null,
    localTracks: [],
    opponentLeftCheckTimer: null,
    isMatchActive: false,
    opponentLeft: false,
  };

  const RANKS = [
    { min: 0,    name: 'Новичок Дискуссии' },
    { min: 600,  name: 'Словесный Боец' },
    { min: 1200, name: 'Мастер Аргумента' },
    { min: 1800, name: 'Оратор Ринга' },
    { min: 2400, name: 'Легенда OPPOSE' },
  ];

  const CATEGORY_HINTS = {
    light: 'Бытовые темы. Разогрев без крови на ринге.',
    hardcore: 'Острые темы, жёсткий тайминг. Судья строже к воде в речи.',
  };

  const CATEGORY_LABELS = { light: 'Лайт', hardcore: 'Хардкор' };

  const TOPICS = {
    light: [
      'Удалёнка убивает продуктивность',
      'Кофе лучше чая',
      'Утро продуктивнее вечера',
      'Отпуск нужно планировать заранее',
      'Сериалы вреднее книг',
    ],
    hardcore: [
      'ИИ заменит большинство профессий за 10 лет',
      '4-дневная рабочая неделя обязана стать нормой',
      'Соцсети нужно регулировать как табак',
      'Высшее образование переоценено',
      'Удалённая демократия эффективнее очной',
    ],
  };

  const AI_HINTS = [
    'Подсказка ИИ: обозначь тезис в первые 10 секунд — судья оценивает структуру.',
    'Подсказка ИИ: оппонент повторяет один и тот же довод — попроси у него новый аргумент.',
    'Подсказка ИИ: добавь конкретный пример, абстрактные тезисы теряют очки.',
    'Подсказка ИИ: ты начал повышать тон — вернись к фактам, это убедительнее.',
    'Подсказка ИИ: используй контраргумент оппонента против него самого.',
    'Подсказка ИИ: до конца раунда осталось мало времени — переходи к выводу.',
  ];

  const PHASES = [
    { key: 'prep',  label: 'Подготовка',       duration: 30 },
    { key: 's1',    label: 'Спикер 1',          duration: 90 },
    { key: 's2',    label: 'Спикер 2',          duration: 90 },
    { key: 'free',  label: 'Свободный спор',    duration: 90 },
  ];

  const TIMER_CIRCUMFERENCE = 2 * Math.PI * 52; // matches r=52 in the SVG

  /* ============================================================
     Element refs
     ============================================================ */
  const screens = {
    menu: document.getElementById('screen-menu'),
    matchmaking: document.getElementById('screen-matchmaking'),
    ring: document.getElementById('screen-ring'),
    verdict: document.getElementById('screen-verdict'),
  };

  const el = {
    userElo: document.getElementById('userElo'),
    userRank: document.getElementById('userRank'),
    eloBarFill: document.getElementById('eloBarFill'),
    categoryToggle: document.getElementById('categoryToggle'),
    categoryHint: document.getElementById('categoryHint'),
    btnFight: document.getElementById('btnFight'),

    mmSearching: document.getElementById('mmSearching'),
    mmTimeout: document.getElementById('mmTimeout'),
    mmError: document.getElementById('mmError'),
    mmTimer: document.getElementById('mmTimer'),
    mmCategory: document.getElementById('mmCategory'),
    btnCancelSearch: document.getElementById('btnCancelSearch'),
    btnBackFromTimeout: document.getElementById('btnBackFromTimeout'),

    ringTopic: document.getElementById('ringTopic'),
    ringRole: document.getElementById('ringRole'),
    timerValue: document.getElementById('timerValue'),
    timerPhase: document.getElementById('timerPhase'),
    timerProgress: document.getElementById('timerProgress'),
    aiHintText: document.getElementById('aiHintText'),
    btnEndFight: document.getElementById('btnEndFight'),
    ringError: document.getElementById('ringError'),

    localVideo: document.getElementById('local-video'),
    remoteVideo: document.getElementById('remote-video'),
    remoteAudio: document.getElementById('remote-audio'),
    videoPlaceholderYou: document.getElementById('videoPlaceholderYou'),
    videoPlaceholderOpp: document.getElementById('videoPlaceholderOpp'),

    opponentLeftBackdrop: document.getElementById('opponentLeftBackdrop'),
    opponentLeftModal: document.getElementById('opponentLeftModal'),
    btnOpponentLeftMenu: document.getElementById('btnOpponentLeftMenu'),

    verdictOutcome: document.getElementById('verdictOutcome'),
    verdictText: document.getElementById('verdictText'),
    eloChangeValue: document.getElementById('eloChangeValue'),
    eloNewTotal: document.getElementById('eloNewTotal'),
    btnReturnMenu: document.getElementById('btnReturnMenu'),
  };

  el.timerProgress.style.strokeDasharray = String(TIMER_CIRCUMFERENCE);

  /* ============================================================
     Screen switching
     ============================================================ */
  function showScreen(name) {
    console.log('[OPPOSE] showScreen ->', name);

    // Guaranteed cleanup: no matter which screen we're switching to, the
    // "opponent left" modal must never linger on top of it.
    hideOpponentLeftOverlay();

    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle('hidden', key !== name);
    });
  }

  function hideOpponentLeftOverlay() {
    if (state.opponentLeftCheckTimer) {
      clearTimeout(state.opponentLeftCheckTimer);
      state.opponentLeftCheckTimer = null;
    }
    if (!el.opponentLeftBackdrop || !el.opponentLeftModal) return;
    el.opponentLeftBackdrop.classList.add('hidden');
    el.opponentLeftBackdrop.style.display = 'none';
    el.opponentLeftModal.classList.add('hidden');
    el.opponentLeftModal.style.display = 'none';
  }

  function showMatchmakingView(view) {
    // view: 'searching' | 'timeout'
    el.mmSearching.classList.toggle('hidden', view !== 'searching');
    el.mmTimeout.classList.toggle('hidden', view !== 'timeout');
  }

  function showMmError(message) {
    console.error('[OPPOSE] UI error (matchmaking):', message);
    el.mmError.textContent = message;
    el.mmError.classList.remove('hidden');
  }

  function clearMmError() {
    el.mmError.textContent = '';
    el.mmError.classList.add('hidden');
  }

  function showRingError(message) {
    console.error('[OPPOSE] UI error (ring):', message);
    if (!el.ringError) return;
    el.ringError.textContent = message;
    el.ringError.classList.remove('hidden');
  }

  function clearRingError() {
    if (!el.ringError) return;
    el.ringError.textContent = '';
    el.ringError.classList.add('hidden');
  }

  /* ============================================================
     Helpers
     ============================================================ */
  function formatMMSS(totalSeconds) {
    const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function rankForElo(elo) {
    let current = RANKS[0].name;
    for (const r of RANKS) {
      if (elo >= r.min) current = r.name;
    }
    return current;
  }

  function renderUserCard() {
    el.userElo.textContent = state.elo.toLocaleString('ru-RU');
    el.userRank.textContent = rankForElo(state.elo);
    const nextThreshold = RANKS.find(r => r.min > state.elo);
    const prevThreshold = [...RANKS].reverse().find(r => r.min <= state.elo) || RANKS[0];
    const pct = nextThreshold
      ? ((state.elo - prevThreshold.min) / (nextThreshold.min - prevThreshold.min)) * 100
      : 100;
    el.eloBarFill.style.width = `${Math.max(4, Math.min(100, pct))}%`;
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /* ============================================================
     Screen 1 — Menu / category toggle
     ============================================================ */
  el.categoryToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-opt');
    if (!btn) return;
    state.category = btn.dataset.cat;
    [...el.categoryToggle.children].forEach(b => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
    el.categoryHint.textContent = CATEGORY_HINTS[state.category];
    console.log('[OPPOSE] Category changed to:', state.category);
  });

  el.btnFight.addEventListener('click', startMatchmaking);

  /* ============================================================
     3. Matchmaking (Supabase-backed)
     ============================================================ */
  async function startMatchmaking() {
    if (!sb) {
      showMmError('Supabase не инициализирован. Проверь подключение SDK.');
      showScreen('matchmaking');
      showMatchmakingView('timeout');
      return;
    }

    clearMmError();
    state.ringEntered = false;
    state.opponentLeft = false;
    state.roomId = null;
    state.myQueueRowId = null;
    const categoryLabel = CATEGORY_LABELS[state.category];

    console.log('[OPPOSE] Starting matchmaking. userId=%s category=%s', state.userId, categoryLabel);

    state.searchSeconds = 0;
    el.mmTimer.textContent = '00:00';
    el.mmCategory.textContent = categoryLabel;
    showMatchmakingView('searching');
    showScreen('matchmaking');

    clearInterval(state.searchTimer);
    state.searchTimer = setInterval(() => {
      state.searchSeconds += 1;
      el.mmTimer.textContent = formatMMSS(state.searchSeconds);
    }, 1000);

    // Give up and show the "opponents are busy" state if nobody is
    // found within SEARCH_TIMEOUT_MS.
    clearTimeout(state.matchTimeout);
    state.matchTimeout = setTimeout(() => {
      console.warn('[OPPOSE] Search timed out after %dms', SEARCH_TIMEOUT_MS);
      giveUpSearch();
    }, SEARCH_TIMEOUT_MS);

    try {
      console.log('[OPPOSE] Step: searching for a waiting opponent in category "%s"...', categoryLabel);
      const { data: candidates, error: selectError } = await sb
        .from(QUEUE_TABLE)
        .select('id, user_id')
        .eq('status', 'waiting')
        .eq('category', categoryLabel)
        .neq('user_id', state.userId)
        .limit(1);

      if (selectError) {
        console.error('[OPPOSE] Error while searching for opponent:', selectError);
        throw selectError;
      }

      const opponent = candidates && candidates[0];

      if (opponent) {
        console.log('[OPPOSE] Opponent found:', opponent);
        await matchWithOpponent(opponent, categoryLabel);
      } else {
        console.log('[OPPOSE] No opponent waiting yet — inserting our own row as "waiting"...');
        await enterQueueAndWait(categoryLabel);
      }
    } catch (err) {
      console.error('[OPPOSE] Matchmaking error:', err);
      showMmError('Ошибка подключения к серверу поиска: ' + (err.message || 'неизвестная ошибка'));
    }
  }

  async function matchWithOpponent(opponent, categoryLabel) {
    const categoryKey = categoryLabel === 'Хардкор' ? 'hardcore' : 'light';
    const roomId = generateRoomId();
    const topic = pick(TOPICS[categoryKey]);
    const myRole = Math.random() < 0.5 ? 'ЗА' : 'ПРОТИВ';
    const oppRole = myRole === 'ЗА' ? 'ПРОТИВ' : 'ЗА';

    console.log('[OPPOSE] Step: claiming opponent row id=%s (room_id=%s, topic="%s")', opponent.id, roomId, topic);

    // Claim the opponent's row first — only succeeds while it's still
    // 'waiting', which prevents two clients double-matching one player.
    const { data: claimed, error: claimError } = await sb
      .from(QUEUE_TABLE)
      .update({ status: 'matched', room_id: roomId, role: oppRole, topic })
      .eq('id', opponent.id)
      .eq('status', 'waiting')
      .select();

    if (claimError) {
      console.error('[OPPOSE] Error claiming opponent row:', claimError);
      throw claimError;
    }

    if (!claimed || claimed.length === 0) {
      console.warn('[OPPOSE] Opponent was claimed by someone else first. Falling back to our own queue entry.');
      await enterQueueAndWait(categoryLabel);
      return;
    }

    console.log('[OPPOSE] Opponent row updated to "matched". Step: inserting our own row as "matched"...');
    const { data: myRow, error: insertError } = await sb
      .from(QUEUE_TABLE)
      .insert({
        user_id: state.userId,
        category: categoryLabel,
        status: 'matched',
        room_id: roomId,
        role: myRole,
        topic,
      })
      .select();

    if (insertError) {
      console.error('[OPPOSE] Error inserting our own matched row:', insertError);
      throw insertError;
    }

    state.myQueueRowId = myRow && myRow[0] ? myRow[0].id : null;
    console.log('[OPPOSE] Match complete. room_id=%s myRole=%s myQueueRowId=%s', roomId, myRole, state.myQueueRowId);

    enterRingFromMatch({ room_id: roomId, role: myRole, topic });
  }

  async function enterQueueAndWait(categoryLabel) {
    const { data: myRow, error: insertError } = await sb
      .from(QUEUE_TABLE)
      .insert({
        user_id: state.userId,
        category: categoryLabel,
        status: 'waiting',
      })
      .select();

    if (insertError) {
      console.error('[OPPOSE] Error inserting waiting row:', insertError);
      throw insertError;
    }

    state.myQueueRowId = myRow && myRow[0] ? myRow[0].id : null;
    console.log('[OPPOSE] Inserted waiting row. id=%s user_id=%s', state.myQueueRowId, state.userId);

    subscribeToOwnRow();
  }

  function subscribeToOwnRow() {
    if (state.queueChannel) {
      console.log('[OPPOSE] Removing previous realtime channel before resubscribing.');
      sb.removeChannel(state.queueChannel);
      state.queueChannel = null;
    }

    console.log('[OPPOSE] Step: subscribing to realtime updates for user_id=%s...', state.userId);
    state.queueChannel = sb
      .channel(`queue-${state.userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: QUEUE_TABLE, filter: `user_id=eq.${state.userId}` },
        (payload) => {
          console.log('[OPPOSE] Realtime UPDATE received for our row:', payload.new);
          const row = payload.new;
          if (row && row.status === 'matched') {
            enterRingFromMatch(row);
          }
        }
      )
      .subscribe((status) => {
        console.log('[OPPOSE] Realtime channel status:', status);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          showMmError('Проблема с realtime-подключением. Продолжаем ждать...');
        }
      });
  }

  function enterRingFromMatch(row) {
    if (state.ringEntered) return; // guard against double-trigger (self update + realtime echo)
    state.ringEntered = true;

    console.log('[OPPOSE] Entering ring. room_id=%s role=%s topic="%s"', row.room_id, row.role, row.topic);

    clearInterval(state.searchTimer);
    clearTimeout(state.matchTimeout);
    if (state.queueChannel) {
      sb.removeChannel(state.queueChannel);
      state.queueChannel = null;
    }
    state.roomId = row.room_id;
    enterRing(row.topic, row.role);
  }

  async function giveUpSearch() {
    clearInterval(state.searchTimer);
    if (state.queueChannel) {
      sb.removeChannel(state.queueChannel);
      state.queueChannel = null;
    }
    try {
      console.log('[OPPOSE] Step: deactivating our waiting row after timeout...');
      const { error } = await sb
        .from(QUEUE_TABLE)
        .delete()
        .eq('user_id', state.userId)
        .eq('status', 'waiting');
      if (error) {
        console.error('[OPPOSE] Error deactivating row after timeout:', error);
      } else {
        console.log('[OPPOSE] Waiting row removed after timeout.');
      }
    } catch (err) {
      console.error('[OPPOSE] Unexpected error during timeout cleanup:', err);
    }
    showMatchmakingView('timeout');
  }

  el.btnCancelSearch.addEventListener('click', async () => {
    console.log('[OPPOSE] User cancelled search manually.');
    clearInterval(state.searchTimer);
    clearTimeout(state.matchTimeout);
    if (state.queueChannel) {
      sb.removeChannel(state.queueChannel);
      state.queueChannel = null;
    }
    try {
      const { error } = await sb.from(QUEUE_TABLE).delete().eq('user_id', state.userId).eq('status', 'waiting');
      if (error) console.error('[OPPOSE] Error removing row on manual cancel:', error);
      else console.log('[OPPOSE] Row removed after manual cancel.');
    } catch (err) {
      console.error('[OPPOSE] Unexpected error on manual cancel:', err);
    }
    showScreen('menu');
  });

  el.btnBackFromTimeout.addEventListener('click', () => {
    showMatchmakingView('searching');
    showScreen('menu');
  });

  /* ============================================================
     4. LiveKit video chat
     ============================================================ */
  async function connectToLiveKit(roomId) {
    // 1. Hard-hide the "opponent left" modal the moment we start connecting
    // a new match — it must never be able to sit on top of a fresh call.
    hideOpponentLeftOverlay();
    state.isMatchActive = false;

    if (!LK) {
      showRingError('Видео недоступно: LiveKit SDK не загружен.');
      return;
    }

    console.log('[OPPOSE] Step: requesting LiveKit token for room=%s user=%s', roomId, state.userId);
    let token;
    try {
      const res = await fetch(LIVEKIT_TOKEN_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
        },
        body: JSON.stringify({ room: roomId, username: state.userId }),
      });
      if (!res.ok) {
        throw new Error(`Функция выдачи токена вернула статус ${res.status}`);
      }
      const data = await res.json();
      token = data.token || data.accessToken || data.jwt;
      if (!token) throw new Error('В ответе функции не найден токен доступа');
      console.log('[OPPOSE] LiveKit token received.');
    } catch (err) {
      console.error('[OPPOSE] Failed to fetch LiveKit token:', err);
      showRingError('Не удалось получить токен видеосвязи: ' + (err.message || 'ошибка сети'));
      return;
    }

    disconnectLiveKit(); // clean up any previous session first

    // 1. Acquire local camera + mic tracks BEFORE connecting to the room.
    // Doing this up front (instead of via enableCameraAndMicrophone() after
    // connect) means the browser's getUserMedia prompt/negotiation never
    // blocks the signalling connection itself.
    let localTracks = [];
    try {
      console.log('[OPPOSE] Step: requesting local camera + microphone tracks (before connect)...');
      localTracks = await LK.createLocalTracks({ audio: true, video: true });
      state.localTracks = localTracks;
      console.log('[OPPOSE] Local tracks acquired:', localTracks.map((t) => t.kind).join(', '));
    } catch (err) {
      console.error('[OPPOSE] Error acquiring local camera/mic tracks:', err);
      showRingError('Нет доступа к камере/микрофону: ' + (err.message || 'проверь разрешения браузера'));
      // Non-fatal — we still try to join the room so the user can at least
      // see/hear the opponent even without publishing their own media.
    }

    // Show the local preview immediately, independent of whether the
    // room connects or the track ever successfully publishes.
    const localVideoTrack = localTracks.find((t) => t.kind === 'video');
    if (localVideoTrack) {
      localVideoTrack.attach(el.localVideo);
      showVideoTrack(el.localVideo, el.videoPlaceholderYou);
    }

    // 3. Explicit vp8 video codec on the room's publish defaults speeds up
    // the publish handshake and avoids codec-negotiation stalls.
    const room = new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: { videoCodec: 'vp8' },
    });
    state.livekitRoom = room;

    room.on(LK.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log('[OPPOSE] Event: TrackSubscribed — kind=%s from=%s', track.kind, participant.identity);
      if (track.kind === 'video') {
        track.attach(el.remoteVideo);
        showVideoTrack(el.remoteVideo, el.videoPlaceholderOpp);
      } else if (track.kind === 'audio' && el.remoteAudio) {
        track.attach(el.remoteAudio);
      }
    });

    room.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
      console.log('[OPPOSE] Event: TrackUnsubscribed — kind=%s', track.kind);
      track.detach();
    });

    // Full connection-lifecycle logging so the real cause of any drop is
    // visible in the console instead of us having to guess.
    room.on(LK.RoomEvent.Connected, () => {
      console.log('[OPPOSE] Event: Connected. Remote participants already in room:', room.remoteParticipants.size);
    });

    room.on(LK.RoomEvent.ParticipantConnected, (participant) => {
      console.log('[OPPOSE] Event: ParticipantConnected —', participant.identity);
      // Someone (re)joined — whatever earlier disconnect we were about to
      // confirm is stale noise, not a real departure. Cancel it.
      if (state.opponentLeftCheckTimer) {
        console.log('[OPPOSE] Cancelling pending opponent-left check — a participant (re)connected.');
        clearTimeout(state.opponentLeftCheckTimer);
        state.opponentLeftCheckTimer = null;
      }
    });

    room.on(LK.RoomEvent.Reconnecting, () => {
      console.warn('[OPPOSE] Event: Reconnecting to LiveKit...');
    });

    room.on(LK.RoomEvent.Reconnected, () => {
      console.log('[OPPOSE] Event: Reconnected to LiveKit.');
    });

    room.on(LK.RoomEvent.ConnectionStateChanged, (connectionState) => {
      console.log('[OPPOSE] Event: ConnectionStateChanged ->', connectionState);
    });

    // 5. Auto-sync: opponent leaving the room.
    // Rule: show the "opponent left" modal ONLY when a ParticipantDisconnected
    // event has fired, the match is actually active, AND the room is
    // physically empty of other participants right now — otherwise it's
    // noise (a duplicate/stale session dropping while the real opponent is
    // still connected) and we ignore it outright. If it does look like a
    // real departure, we still don't act on it immediately: we schedule one
    // confirmation pinned to RING_ENTRY_GRACE_MS (5s) after connecting, and
    // a later ParticipantConnected cancels it.
    room.on(LK.RoomEvent.ParticipantDisconnected, (participant) => {
      console.warn('[OPPOSE] Event: ParticipantDisconnected — identity=%s', participant.identity);

      if (!state.isMatchActive) {
        console.log('[OPPOSE] Ignoring — no active match right now (isMatchActive=false).');
        return;
      }

      const remainingNow = room.remoteParticipants ? room.remoteParticipants.size : 0;
      if (remainingNow > 0) {
        console.log(
          '[OPPOSE] Ignoring — room.remoteParticipants.size=%d, the opponent is still physically in the room.',
          remainingNow
        );
        return;
      }

      scheduleOpponentLeftCheck(room);
    });

    room.on(LK.RoomEvent.Disconnected, (reason) => {
      console.log('[OPPOSE] Event: Disconnected. reason=%s', reason);
    });

    room.on(LK.RoomEvent.MediaDevicesError, (err) => {
      console.error('[OPPOSE] Event: MediaDevicesError:', err);
      showRingError('Нет доступа к камере/микрофону: ' + (err.message || 'проверь разрешения браузера'));
    });

    // 2. Connect to the signalling server first...
    try {
      console.log('[OPPOSE] Step: connecting to LiveKit room at %s...', LIVEKIT_URL);
      await room.connect(LIVEKIT_URL, token);
      state.roomConnectedAt = Date.now();
      state.isMatchActive = true;
      console.log('[OPPOSE] Connected to LiveKit room:', room.name, '— isMatchActive=true');
      clearRingError();
      // 1. Guaranteed cleanup on successful connect: the "opponent left"
      // modal (if it somehow survived from a previous match) must not sit
      // on top of a freshly-connected video call.
      state.opponentLeft = false;
      hideOpponentLeftOverlay();
    } catch (err) {
      console.error('[OPPOSE] room.connect() failed:', err);
      showRingError('Не удалось подключиться к видеосвязи: ' + (err.message || 'ошибка соединения'));
      return; // no point trying to publish without a live connection
    }

    // ...then publish each already-acquired track separately, each with
    // its own try/catch. If a publish call times out or fails, we log it
    // and surface a non-fatal notice — we deliberately do NOT disconnect
    // the room or trigger the "Связь потеряна" flow over a slow publish.
    for (const track of localTracks) {
      try {
        console.log('[OPPOSE] Step: publishing local track kind=%s...', track.kind);
        await room.localParticipant.publishTrack(track, {
          videoCodec: track.kind === 'video' ? 'vp8' : undefined,
        });
        console.log('[OPPOSE] Published local track kind=%s successfully.', track.kind);
      } catch (err) {
        console.error('[OPPOSE] Publish failed/timed out for track kind=%s:', track.kind, err);
        showRingError(
          `Соперник может временно не видеть/слышать тебя (не удалось опубликовать ${track.kind === 'video' ? 'видео' : 'аудио'}). Бой продолжается.`
        );
        // No disconnectLiveKit() / handleOpponentLeft() here on purpose.
      }
    }
  }

  function showVideoTrack(videoEl, placeholderEl) {
    videoEl.classList.remove('hidden');
    Object.assign(videoEl.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      borderRadius: 'inherit',
      zIndex: '1',
    });
    if (placeholderEl) placeholderEl.style.display = 'none';
  }

  function resetVideoTrack(videoEl, placeholderEl) {
    if (videoEl) {
      videoEl.classList.add('hidden');
      videoEl.srcObject = null;
    }
    if (placeholderEl) placeholderEl.style.display = '';
  }

  function disconnectLiveKit() {
    state.isMatchActive = false;
    if (state.opponentLeftCheckTimer) {
      clearTimeout(state.opponentLeftCheckTimer);
      state.opponentLeftCheckTimer = null;
    }
    if (state.localTracks && state.localTracks.length) {
      console.log('[OPPOSE] Stopping locally-acquired tracks (published or not)...');
      state.localTracks.forEach((track) => {
        try {
          track.stop();
        } catch (err) {
          console.error('[OPPOSE] Error stopping local track:', err);
        }
      });
      state.localTracks = [];
    }
    if (state.livekitRoom) {
      // 2. Strip every listener from the outgoing room BEFORE disconnecting
      // it, so any in-flight event from the old call (e.g. a delayed
      // ParticipantDisconnected) can never reach and affect the next match.
      console.log('[OPPOSE] Removing all listeners from the outgoing LiveKit room...');
      try {
        state.livekitRoom.removeAllListeners();
      } catch (err) {
        console.error('[OPPOSE] Error removing listeners from LiveKit room:', err);
      }
      console.log('[OPPOSE] Disconnecting from LiveKit room...');
      try {
        state.livekitRoom.disconnect();
      } catch (err) {
        console.error('[OPPOSE] Error while disconnecting LiveKit room:', err);
      }
      state.livekitRoom = null;
      state.roomConnectedAt = null;
    }
    resetVideoTrack(el.localVideo, el.videoPlaceholderYou);
    resetVideoTrack(el.remoteVideo, el.videoPlaceholderOpp);
    if (el.remoteAudio) el.remoteAudio.srcObject = null;
  }

  function scheduleOpponentLeftCheck(room) {
    clearTimeout(state.opponentLeftCheckTimer);

    const elapsed = state.roomConnectedAt ? Date.now() - state.roomConnectedAt : Infinity;
    const SETTLE_BUFFER_MS = 300; // let room.remoteParticipants settle after the event
    const waitFor = Math.max(0, RING_ENTRY_GRACE_MS - elapsed) + SETTLE_BUFFER_MS;

    console.log(
      '[OPPOSE] Opponent-left check scheduled in %dms (fires no earlier than %dms after connect; elapsed so far=%dms).',
      waitFor,
      RING_ENTRY_GRACE_MS,
      elapsed
    );

    state.opponentLeftCheckTimer = setTimeout(() => {
      state.opponentLeftCheckTimer = null;
      const remaining = room.remoteParticipants ? room.remoteParticipants.size : 0;
      console.log('[OPPOSE] Opponent-left check firing. room.remoteParticipants.size=%d', remaining);
      if (remaining === 0) {
        handleOpponentLeft();
      } else {
        console.log('[OPPOSE] Room still has remote participants — the earlier disconnect was noise, not showing the overlay.');
      }
    }, waitFor);
  }

  function handleOpponentLeft() {
    if (state.opponentLeft) return;
    state.opponentLeft = true;

    console.warn('[OPPOSE] Opponent left the ring — showing notice.');
    stopRingTimers();
    disconnectLiveKit();
    el.opponentLeftBackdrop.style.display = '';
    el.opponentLeftBackdrop.classList.remove('hidden');
    el.opponentLeftModal.style.display = '';
    el.opponentLeftModal.classList.remove('hidden');

    // The fight is effectively over — clean up our own queue row too.
    if (state.userId) {
      sb.from(QUEUE_TABLE).delete().eq('user_id', state.userId).then(({ error }) => {
        if (error) console.error('[OPPOSE] Error cleaning up queue row after opponent left:', error);
      });
    }
  }

  el.btnOpponentLeftMenu.addEventListener('click', () => {
    hideOpponentLeftOverlay();
    state.opponentLeft = false;
    clearRingError();
    renderUserCard();
    showScreen('menu');
  });

  /* ============================================================
     Screen 3 — Ring / fight
     ============================================================ */
  function enterRing(topic, role) {
    // 2. Reset every ring UI overlay/error right as we enter, so nothing
    // from a previous fight (error banners, the opponent-left modal) can
    // linger on top of the new one.
    state.opponentLeft = false;
    hideOpponentLeftOverlay();
    clearRingError();

    el.ringTopic.textContent = topic || pick(TOPICS[state.category]);
    state.role = role || (Math.random() < 0.5 ? 'ЗА' : 'ПРОТИВ');
    el.ringRole.innerHTML = `Ты: <strong>${state.role}</strong>`;

    state.phaseIndex = 0;
    showScreen('ring');
    startPhase(0);
    startHintRotation();

    // Fire-and-forget: connect to the LiveKit room in the background so
    // the ring UI is never blocked waiting on camera/mic permissions.
    connectToLiveKit(state.roomId);
  }

  function startPhase(index) {
    if (index >= PHASES.length) {
      endFight('rounds-complete');
      return;
    }
    state.phaseIndex = index;
    const phase = PHASES[index];
    state.phaseRemaining = phase.duration;
    el.timerPhase.textContent = phase.label;
    updateTimerDisplay(phase.duration);

    clearInterval(state.phaseTimer);
    state.phaseTimer = setInterval(() => {
      state.phaseRemaining -= 1;
      updateTimerDisplay(PHASES[state.phaseIndex].duration);
      if (state.phaseRemaining <= 0) {
        clearInterval(state.phaseTimer);
        startPhase(state.phaseIndex + 1);
      }
    }, 1000);
  }

  function updateTimerDisplay(phaseDuration) {
    el.timerValue.textContent = formatMMSS(Math.max(0, state.phaseRemaining));
    const fraction = Math.max(0, state.phaseRemaining) / phaseDuration;
    el.timerProgress.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * (1 - fraction));
    el.timerProgress.style.stroke = state.phaseRemaining <= 10 ? 'var(--loss)' : 'var(--accent)';
  }

  function startHintRotation() {
    el.aiHintText.textContent = pick(AI_HINTS);
    clearInterval(state.hintTimer);
    state.hintTimer = setInterval(() => {
      el.aiHintText.textContent = pick(AI_HINTS);
    }, 7000);
  }

  el.btnEndFight.addEventListener('click', () => endFight('manual'));

  function stopRingTimers() {
    clearInterval(state.phaseTimer);
    clearInterval(state.hintTimer);
  }

  /* ============================================================
     Screen 4 — Verdict
     ============================================================ */
  function endFight() {
    if (state.opponentLeft) return; // already handled by the opponent-left flow
    stopRingTimers();
    disconnectLiveKit();

    const won = Math.random() < 0.55; // slight favor to keep the demo encouraging
    const delta = won ? (18 + Math.floor(Math.random() * 15)) : -(10 + Math.floor(Math.random() * 15));
    const newElo = Math.max(0, state.elo + delta);

    el.verdictOutcome.textContent = won ? 'Победа' : 'Поражение';
    el.verdictOutcome.className = `verdict-outcome ${won ? 'win' : 'loss'}`;

    el.verdictText.textContent = won
      ? 'Твоя аргументация была структурнее: ты держался тезиса и подкреплял его примерами, тогда как оппонент чаще уходил в эмоции.'
      : 'Оппонент точнее держал регламент и закрыл спор конкретными примерами — твоим доводам не хватило структуры во втором раунде.';

    el.eloChangeValue.textContent = `${delta > 0 ? '+' : ''}${delta} ELO`;
    el.eloChangeValue.className = `elo-change-value ${won ? 'win' : 'loss'}`;
    el.eloNewTotal.textContent = newElo.toLocaleString('ru-RU');
    document.querySelector('.elo-change-total').firstChild.textContent = `${state.elo.toLocaleString('ru-RU')} → `;

    state.elo = newElo;
    showScreen('verdict');

    // Best-effort cleanup of our queue row now that the fight is over.
    console.log('[OPPOSE] Step: cleaning up queue row after fight end...');
    sb.from(QUEUE_TABLE).delete().eq('user_id', state.userId).then(({ error }) => {
      if (error) console.error('[OPPOSE] Error cleaning up queue row:', error);
      else console.log('[OPPOSE] Queue row cleaned up.');
    });
  }

  el.btnReturnMenu.addEventListener('click', () => {
    renderUserCard();
    showScreen('menu');
  });

  /* ============================================================
     6. Cleanup on tab close / navigation away
     ============================================================ */
  window.addEventListener('beforeunload', () => {
    console.log('[OPPOSE] beforeunload: releasing resources...');

    // Leave the LiveKit room immediately (best-effort, no await possible here).
    if (state.livekitRoom) {
      try {
        state.livekitRoom.disconnect();
      } catch (err) {
        console.error('[OPPOSE] beforeunload: error disconnecting LiveKit room:', err);
      }
    }

    // A plain supabase-js call is a Promise that the browser won't wait for
    // during unload, so we issue a raw keepalive fetch straight to the
    // Supabase REST endpoint to make sure the row actually gets removed.
    if (state.userId) {
      try {
        fetch(`${SUPABASE_URL}/rest/v1/${QUEUE_TABLE}?user_id=eq.${encodeURIComponent(state.userId)}`, {
          method: 'DELETE',
          keepalive: true,
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        });
      } catch (err) {
        console.error('[OPPOSE] beforeunload: error cleaning up queue row:', err);
      }
    }
  });

  /* ============================================================
     Init
     ============================================================ */
  console.log('[OPPOSE] App init. userId=%s', state.userId);
  renderUserCard();
  el.categoryHint.textContent = CATEGORY_HINTS[state.category];
  showScreen('menu');
})();

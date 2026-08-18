(() => {
  'use strict';

  /* ============================================================
     1. Supabase init
     ============================================================ */
  const SUPABASE_URL = 'https://gjyuudqxbimumpnsesky.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_Q9Y4HCWbc-_tG3-32GB0PQ_x9sYJIIF';

  let sb = null;
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[OPPOSE] Supabase client initialized:', SUPABASE_URL);
  } catch (err) {
    console.error('[OPPOSE] Failed to initialize Supabase client:', err);
  }

  const QUEUE_TABLE = 'matchmaking_queue';
  const SEARCH_TIMEOUT_MS = 30000;

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
    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle('hidden', key !== name);
    });
  }

  function showMatchmakingView(view) {
    // view: 'searching' | 'timeout'
    el.mmSearching.classList.toggle('hidden', view !== 'searching');
    el.mmTimeout.classList.toggle('hidden', view !== 'timeout');
  }

  function showMmError(message) {
    console.error('[OPPOSE] UI error:', message);
    el.mmError.textContent = message;
    el.mmError.classList.remove('hidden');
  }

  function clearMmError() {
    el.mmError.textContent = '';
    el.mmError.classList.add('hidden');
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
      // 3a. Look for an opponent already waiting in the same category.
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
    // Insert our own row as 'waiting' with user_id set on every request,
    // as required by the matchmaking_queue schema.
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

    // Subscribe to realtime UPDATE events on our own row, filtered by
    // user_id, so we're notified the instant another client matches us.
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
          showMmError('Проблема с realtime-подключением. Продолжаем ждать через опрос.');
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
     Screen 3 — Ring / fight
     ============================================================ */
  function enterRing(topic, role) {
    el.ringTopic.textContent = topic || pick(TOPICS[state.category]);
    state.role = role || (Math.random() < 0.5 ? 'ЗА' : 'ПРОТИВ');
    el.ringRole.innerHTML = `Ты: <strong>${state.role}</strong>`;

    state.phaseIndex = 0;
    showScreen('ring');
    startPhase(0);
    startHintRotation();
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
    stopRingTimers();

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
    sb.from(QUEUE_TABLE).delete().eq('user_id', state.userId).then(
      ({ error }) => {
        if (error) console.error('[OPPOSE] Error cleaning up queue row:', error);
        else console.log('[OPPOSE] Queue row cleaned up.');
      }
    );
  }

  el.btnReturnMenu.addEventListener('click', () => {
    renderUserCard();
    showScreen('menu');
  });

  /* ============================================================
     Init
     ============================================================ */
  console.log('[OPPOSE] App init. userId=%s', state.userId);
  renderUserCard();
  el.categoryHint.textContent = CATEGORY_HINTS[state.category];
  showScreen('menu');
})();

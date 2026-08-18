(() => {
  'use strict';

  /* ============================================================
     State
     ============================================================ */
  const state = {
    elo: 1000,
    category: 'light',
    searchTimer: null,
    searchSeconds: 0,
    phaseIndex: 0,
    phaseRemaining: 0,
    phaseTimer: null,
    hintTimer: null,
    role: 'ЗА',
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

    mmTimer: document.getElementById('mmTimer'),
    mmCategory: document.getElementById('mmCategory'),
    btnCancelSearch: document.getElementById('btnCancelSearch'),

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
    Object.entries(screens).forEach(([key, node]) => {
      node.classList.toggle('hidden', key !== name);
    });
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
  });

  el.btnFight.addEventListener('click', startMatchmaking);

  /* ============================================================
     Screen 2 — Matchmaking
     ============================================================ */
  function startMatchmaking() {
    state.searchSeconds = 0;
    el.mmTimer.textContent = '00:00';
    el.mmCategory.textContent = state.category === 'light' ? 'Лайт' : 'Хардкор';
    showScreen('matchmaking');

    state.searchTimer = setInterval(() => {
      state.searchSeconds += 1;
      el.mmTimer.textContent = formatMMSS(state.searchSeconds);
    }, 1000);

    // Simulated opponent found after a short random delay
    const delay = 2200 + Math.random() * 2200;
    state.searchTimeout = setTimeout(() => {
      clearInterval(state.searchTimer);
      enterRing();
    }, delay);
  }

  el.btnCancelSearch.addEventListener('click', () => {
    clearInterval(state.searchTimer);
    clearTimeout(state.searchTimeout);
    showScreen('menu');
  });

  /* ============================================================
     Screen 3 — Ring / fight
     ============================================================ */
  function enterRing() {
    const topicPool = TOPICS[state.category];
    el.ringTopic.textContent = pick(topicPool);
    state.role = Math.random() < 0.5 ? 'ЗА' : 'ПРОТИВ';
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
  }

  el.btnReturnMenu.addEventListener('click', () => {
    renderUserCard();
    showScreen('menu');
  });

  /* ============================================================
     Init
     ============================================================ */
  renderUserCard();
  el.categoryHint.textContent = CATEGORY_HINTS[state.category];
  showScreen('menu');
})();

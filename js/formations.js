// Slot coordinates are from the team's own perspective:
// x = depth (0 = own goal line, 100 = opponent goal line), y = width (0..100).
(function () {
  const GK = { role: 'GK', x: 4, y: 50 };
  const BACK4 = [
    { role: 'DEF', x: 22, y: 14 },
    { role: 'DEF', x: 19, y: 38 },
    { role: 'DEF', x: 19, y: 62 },
    { role: 'DEF', x: 22, y: 86 },
  ];

  window.FORMATIONS = {
    '4-3-3': [
      GK, ...BACK4,
      { role: 'MID', x: 45, y: 25 },
      { role: 'MID', x: 40, y: 50 },
      { role: 'MID', x: 45, y: 75 },
      { role: 'FWD', x: 70, y: 16 },
      { role: 'FWD', x: 75, y: 50 },
      { role: 'FWD', x: 70, y: 84 },
    ],
    '4-4-2': [
      GK, ...BACK4,
      { role: 'MID', x: 46, y: 12 },
      { role: 'MID', x: 42, y: 38 },
      { role: 'MID', x: 42, y: 62 },
      { role: 'MID', x: 46, y: 88 },
      { role: 'FWD', x: 72, y: 38 },
      { role: 'FWD', x: 72, y: 62 },
    ],
    '4-2-3-1': [
      GK, ...BACK4,
      { role: 'MID', x: 36, y: 36 },
      { role: 'MID', x: 36, y: 64 },
      { role: 'MID', x: 56, y: 15 },
      { role: 'MID', x: 57, y: 50 },
      { role: 'MID', x: 56, y: 85 },
      { role: 'FWD', x: 76, y: 50 },
    ],
    '3-5-2': [
      GK,
      { role: 'DEF', x: 20, y: 25 },
      { role: 'DEF', x: 18, y: 50 },
      { role: 'DEF', x: 20, y: 75 },
      { role: 'MID', x: 46, y: 8 },
      { role: 'MID', x: 40, y: 32 },
      { role: 'MID', x: 36, y: 50 },
      { role: 'MID', x: 40, y: 68 },
      { role: 'MID', x: 46, y: 92 },
      { role: 'FWD', x: 72, y: 38 },
      { role: 'FWD', x: 72, y: 62 },
    ],
  };
})();

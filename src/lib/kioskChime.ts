let context: AudioContext | undefined;

export function primeChime() {
  try {
    const AudioContextClass = window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!context && AudioContextClass) context = new AudioContextClass();
    void context?.resume().catch(() => {});
  } catch { /* Audio is optional; the seal and words carry the meaning. */ }
}

export function playChime() {
  try {
    if (!context || context.state !== 'running') return;
    const now = context.currentTime;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 4000;
    filter.connect(context.destination);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.001, now);
    envelope.gain.linearRampToValueAtTime(0.12, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.368);
    envelope.connect(filter);
    let ended = 0;
    [880, 1320].forEach((frequency, i) => {
      const oscillator = context!.createOscillator();
      const partial = context!.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      partial.gain.value = i === 0 ? 1 : Math.pow(10, -12 / 20);
      oscillator.connect(partial);
      partial.connect(envelope);
      oscillator.onended = () => {
        oscillator.disconnect();
        partial.disconnect();
        if (++ended === 2) { envelope.disconnect(); filter.disconnect(); }
      };
      oscillator.start(now);
      oscillator.stop(now + 0.38);
    });
  } catch { /* Muted or unavailable audio must never interrupt confirmation. */ }
}

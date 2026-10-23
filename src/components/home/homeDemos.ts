/**
 * The home page's moving demos (port of the approved preview's app.js). Every
 * query runs inside `root`; the returned function stops every loop, observer,
 * listener and timer, so nothing keeps running once the page is gone.
 */
export type Api = {
  q: (s: string) => HTMLElement | null;
  w: (ms: number) => Promise<void>;
  add: (c: string) => void;
  rm: (c: string) => void;
  on: (s: string, c?: string) => void;
  off: (s: string, c?: string) => void;
  move: (s: string) => void;
  tap: (s: string, press?: string) => Promise<void>;
  hide: () => void;
  type: (s: string, speed?: number) => Promise<void>;
  fill: (s: string) => void;
};
export type Script = [(a: Api) => Promise<void>, (a: Api) => void];

class Cancel {}

// Each demo's untouched markup, kept per element so a second start (React
// StrictMode runs effects twice) begins from the original, not a played state.
const pristine = new WeakMap<HTMLElement, { html: string; base: string }>();

/**
 * `scripts` (optional): another page's demo table (the agency welcome page);
 * by default the home page's own. Everything else (reveals, top bar, loops,
 * cleanup) is shared.
 */
export function runHomeDemos(root: HTMLElement, reduce: boolean, scripts?: Record<string, Script>): () => void {
  let dead = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };
  const observers: IntersectionObserver[] = [];
  const stops: Array<() => void> = [];
  const hasIO = typeof IntersectionObserver !== 'undefined';

  const top = root.querySelector<HTMLElement>('#top');
  const hero = root.querySelector<HTMLElement>('.hero');
  const onScroll = () => {
    if (top && hero) top.classList.toggle('solid', window.scrollY > hero.offsetHeight - 70);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const reveals = root.querySelectorAll<HTMLElement>('.reveal');
  if (hasIO) {
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    observers.push(io);
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }

  const make = (el: HTMLElement, script: Script[0], still: Script[1]) => {
    if (!pristine.has(el)) pristine.set(el, { html: el.innerHTML, base: el.className });
    const { html, base } = pristine.get(el)!;
    let token = 0;
    const api = (my: number): Api => {
      const q = (s: string) => el.querySelector<HTMLElement>(s);
      const f = () => el.querySelector<HTMLElement>('.finger');
      const a: Api = {
        q,
        w: (ms) => new Promise<void>((res, rej) => {
          later(() => (my === token && !dead ? res() : rej(new Cancel())), ms);
        }),
        add: (c) => el.classList.add(c),
        rm: (c) => el.classList.remove(c),
        on: (s, c) => q(s)?.classList.add(c || 'show'),
        off: (s, c) => q(s)?.classList.remove(c || 'show'),
        move: (s) => {
          const n = q(s);
          const fi = f();
          if (!n || !fi) return;
          const r = n.getBoundingClientRect();
          const b = el.getBoundingClientRect();
          fi.style.setProperty('--x', `${r.left - b.left + r.width / 2}px`);
          fi.style.setProperty('--y', `${r.top - b.top + r.height / 2}px`);
          fi.classList.add('on');
        },
        tap: async (s, press) => {
          a.move(s);
          await a.w(800);
          const fi = f();
          if (fi) {
            fi.classList.remove('tap');
            void fi.offsetWidth;
            fi.classList.add('tap');
          }
          const n = q(press || s);
          n?.classList.add('press');
          await a.w(220);
          n?.classList.remove('press');
        },
        hide: () => f()?.classList.remove('on'),
        type: async (s, speed) => {
          const n = q(s);
          if (!n) return;
          const t = n.dataset.type || '';
          n.classList.add('typing');
          for (let i = 1; i <= t.length; i++) {
            n.textContent = t.slice(0, i);
            await a.w(speed || 70);
          }
          n.classList.remove('typing');
        },
        fill: (s) => {
          const n = q(s);
          if (n) n.textContent = n.dataset.type || '';
        },
      };
      return a;
    };
    const reset = (fade: boolean) => {
      el.innerHTML = html;
      el.className = base + (fade ? ' fadein' : '');
      if (fade) later(() => el.classList.remove('fadein'), 40);
    };
    const loop = async () => {
      const my = ++token;
      let first = true;
      try {
        while (my === token && !dead) {
          reset(!first);
          first = false;
          const A = api(my);
          await script(A);
          el.classList.add('fadeout');
          await A.w(500);
        }
      } catch (e) {
        if (!(e instanceof Cancel)) console.error(e);
      }
    };
    const stop = () => {
      token++;
    };
    stops.push(stop);
    if (reduce) {
      reset(false);
      still(api(-1));
      return;
    }
    if (hasIO) {
      const io = new IntersectionObserver(
        (es) => es.forEach((e) => (e.isIntersecting ? void loop() : stop())),
        { threshold: 0.3 },
      );
      observers.push(io);
      io.observe(el);
    } else {
      void loop();
    }
  };

  const S: Record<string, Script> = scripts ?? {
    hero: [async (a) => {
      await a.w(900); a.on('.p-new'); await a.w(2300); a.off('.p-new'); await a.w(300); a.add('s-new');
      await a.w(1300); await a.tap('.tk-tap .tgt'); a.add('s-done'); a.hide();
      await a.w(4200);
    }, (a) => { a.add('s-new'); a.add('s-done'); }],
    kiosk: [async (a) => {
      a.on('.ks-names'); await a.w(1200);
      await a.tap('.tgt-name'); a.off('.ks-names'); a.on('.ks-pin'); await a.w(500);
      const dots = a.q('.dots')?.children;
      const keys = ['4', '7', '1', '9'];
      for (let i = 0; i < keys.length; i++) { await a.tap(`.ky[data-k="${keys[i]}"]`); dots?.[i]?.classList.add('f'); }
      await a.tap('.ky.go'); a.hide(); a.off('.ks-pin'); a.on('.ks-tasks'); await a.w(400);
      a.add('k-zoom'); await a.w(1900);
      await a.tap('.tgt-done'); a.add('k-done'); a.hide();
      await a.w(2600); a.rm('k-zoom'); await a.w(1800);
    }, (a) => { a.on('.ks-tasks'); a.add('k-zoom'); a.add('k-done'); }],
    connect: [async (a) => {
      const st = root.querySelectorAll('#connect .three li');
      const hl = (n: number) => st.forEach((l, i) => l.classList.toggle('on', i === n));
      hl(0); a.on('.cs-land'); await a.w(1000);
      await a.tap('.tgt-setup'); a.hide(); a.off('.cs-land'); a.on('.cs-code'); await a.w(1500);
      hl(1); await a.w(300); a.move('.mono-in'); await a.w(700); a.hide(); await a.type('.mono-in', 110);
      await a.tap('.sel'); a.on('.sel', 'set'); a.hide(); await a.w(300); await a.type('.f-tname', 55);
      await a.tap('.tgt-pair'); a.hide(); await a.w(500);
      hl(2); a.add('c-paired'); a.off('.cs-code'); a.on('.cs-done');
      await a.w(3800); hl(-1); await a.w(400);
    }, (a) => { a.on('.cs-done'); a.add('c-paired'); a.fill('.mono-in'); a.on('.sel', 'set'); a.fill('.f-tname'); }],
    login: [async (a) => {
      await a.w(700); await a.type('.f-email', 55); await a.type('.pw', 60);
      await a.tap('.tgt-signin'); a.hide(); await a.w(500); a.add('l-offer'); await a.w(1600);
      await a.tap('.tgt-add'); a.hide(); a.add('l-face'); await a.w(1300); a.add('l-faceok'); await a.w(700); a.rm('l-face'); a.rm('l-faceok'); a.rm('l-offer'); a.add('l-done'); await a.w(1500);
      await a.tap('.tgt-ok'); a.hide(); a.rm('l-done'); a.add('l-board'); await a.w(2000);
      // next time
      a.add('l-next'); a.rm('l-board');
      const em = a.q('.f-email'); if (em) em.textContent = '';
      const pw = a.q('.pw'); if (pw) pw.textContent = '';
      await a.w(1300);
      a.add('l-quick'); await a.tap('.tgt-quick'); a.hide(); a.add('l-face'); await a.w(1100); a.add('l-faceok'); await a.w(700); a.rm('l-face'); a.rm('l-faceok'); a.add('l-board');
      await a.w(2600);
    }, (a) => { a.add('l-offer'); a.fill('.f-email'); a.fill('.pw'); }],
    updates: [async (a) => {
      a.add('u1'); await a.w(3600); a.rm('u1'); a.add('u2'); await a.w(3600);
      a.on('.p-alert'); await a.w(2400); a.off('.p-alert'); a.rm('u2'); a.add('u3'); await a.w(1800); a.add('u-ack'); await a.w(3000);
    }, (a) => { a.add('u3'); a.add('u-ack'); }],
    events: [async (a) => {
      await a.w(600); await a.type('.f-evname', 55);
      await a.type('.f-date', 80); await a.type('.f-time', 80);
      await a.tap('.tgt-mash'); a.on('.tgt-mash', 'set'); a.hide(); await a.w(400);
      await a.w(300);
      await a.tap('.tgt-addtask'); a.on('.tgt-addtask', 'set'); a.hide(); await a.w(700);
      await a.tap('.tgt-create'); a.hide(); await a.w(500);
      a.on('.p-ev'); await a.w(2600); a.off('.p-ev'); await a.w(300); a.add('e-got'); await a.w(3000);
    }, (a) => { ['.f-evname', '.f-date', '.f-time'].forEach((s) => a.fill(s)); a.on('.tgt-mash', 'set'); a.on('.tgt-addtask', 'set'); a.add('e-got'); }],
    venues: [async (a) => {
      await a.w(900); await a.tap('.tgt-vb'); a.hide(); a.add('v-open'); await a.w(900);
      await a.tap('.tgt-cb'); a.add('v-tick'); a.hide(); await a.w(700);
      await a.tap('.tgt-end'); a.add('v-until'); a.hide(); await a.w(900);
      await a.tap('.tgt-save'); a.hide(); a.rm('v-open'); a.add('v-saved'); await a.w(3600);
    }, (a) => { a.add('v-saved'); }],
    merge: [async (a) => {
      await a.w(2200); a.add('m-one'); await a.w(1500); a.add('m-phone'); await a.w(1400);
      await a.tap('.tgt-ag'); a.on('.tgt-ag', 'pick'); a.hide(); await a.w(3200);
    }, (a) => { a.add('m-one'); a.add('m-phone'); }],
  };
  root.querySelectorAll<HTMLElement>('[data-demo]').forEach((el) => {
    const s = S[el.dataset.demo || ''];
    if (s) make(el, s[0], s[1]);
  });

  return () => {
    dead = true;
    stops.forEach((stop) => stop());
    observers.forEach((io) => io.disconnect());
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    window.removeEventListener('scroll', onScroll);
  };
}

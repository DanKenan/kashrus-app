import type { Script } from '../home/homeDemos';

/**
 * The agency welcome page's moving demos (port of the approved
 * preview, Oct 23). Run by the home page's engine (runHomeDemos),
 * which keeps every query inside the page and stops everything on unmount.
 * Each entry: [the loop, the still frame shown with reduced motion].
 */
export const WELCOME_SCRIPTS: Record<string, Script> = {
  signin: [async (a) => {
    await a.w(800); await a.type('.f-email', 60); await a.type('.pw', 60);
    await a.tap('.tgt-signin'); a.hide(); await a.w(500); a.add('l-board'); await a.w(3000);
  }, (a) => { a.fill('.f-email'); a.fill('.pw'); }],
  faceid: [async (a) => {
    a.add('l-board'); await a.w(900); a.add('l-offer'); await a.w(1800);
    await a.tap('.tgt-add'); a.hide(); a.add('l-face'); await a.w(1300); a.add('l-faceok'); await a.w(700);
    a.rm('l-face'); a.rm('l-faceok'); a.rm('l-offer'); a.add('l-done'); await a.w(1700);
    await a.tap('.tgt-ok'); a.hide(); a.rm('l-done'); await a.w(1400);
    a.add('l-next'); a.rm('l-board'); await a.w(1400);
    a.add('l-quick'); await a.tap('.tgt-quick'); a.hide(); a.add('l-face'); await a.w(1100); a.add('l-faceok'); await a.w(700);
    a.rm('l-face'); a.rm('l-faceok'); a.add('l-board'); await a.w(2800);
  }, (a) => { a.add('l-board'); a.add('l-offer'); }],
  board: [async (a) => {
    await a.w(500);
    for (let i = 1; i <= 4; i++) { a.add(`bi${i}`); await a.w(420); }
    await a.w(700); a.add('hl'); await a.w(4200);
  }, (a) => { a.add('bi1'); a.add('bi2'); a.add('bi3'); a.add('bi4'); a.add('hl'); }],
  sign: [async (a) => {
    await a.w(1300); await a.tap('.tk-tap .tgt'); a.add('s-done'); a.hide(); await a.w(4200);
  }, (a) => { a.add('s-done'); }],
  install: [async (a) => {
    await a.w(1000); await a.tap('.tgt-share'); a.hide(); a.add('i-share'); await a.w(1300);
    await a.tap('.tgt-a2hs'); a.hide(); a.rm('i-share'); a.add('i-add'); await a.w(1500);
    await a.tap('.tgt-addbtn'); a.hide(); a.rm('i-add'); a.add('i-home'); a.add('l-next'); await a.w(700);
    a.add('i-pop'); await a.w(3600);
  }, (a) => { a.add('i-home'); a.add('i-pop'); a.add('l-next'); }],
  kiosk: [async (a) => {
    a.on('.ks-names'); await a.w(1200);
    await a.tap('.tgt-name'); a.off('.ks-names'); a.on('.ks-pin'); await a.w(500);
    const dots = a.q('.dots')?.children;
    const keys = ['4', '7', '1', '9'];
    for (let i = 0; i < keys.length; i++) { await a.tap(`.ky[data-k="${keys[i]}"]`); dots?.[i]?.classList.add('f'); }
    await a.tap('.ky.go'); a.hide(); a.off('.ks-pin'); a.on('.ks-tasks'); await a.w(400);
    a.add('k-zoom'); await a.w(1900);
    await a.tap('.tgt-done'); a.add('k-done'); a.hide(); await a.w(1100);
    await a.tap('.tgt-done2'); a.add('k-done2'); a.hide(); await a.w(2400);
    await a.tap('.tgt-end'); a.hide(); a.rm('k-zoom'); a.off('.ks-tasks'); a.on('.ks-names'); a.rm('k-done'); a.rm('k-done2'); await a.w(2200);
  }, (a) => { a.on('.ks-tasks'); a.add('k-zoom'); a.add('k-done'); a.add('k-done2'); }],
  updates: [async (a) => {
    a.add('u1'); await a.w(3600); a.rm('u1'); a.add('u2'); await a.w(3600);
    a.on('.p-alert'); await a.w(2400); a.off('.p-alert'); a.rm('u2'); a.add('u3'); await a.w(1800); a.add('u-ack'); await a.w(3000);
  }, (a) => { a.add('u3'); a.add('u-ack'); }],
};

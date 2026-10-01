import React, { useState } from 'react';
import { Download, Smartphone, X, Share2, PlusSquare } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  className?: string;
  variant?: 'header' | 'banner' | 'menu';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  className = '',
  variant = 'header',
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  // If already running as an installed standalone PWA, suppress the prompt
  if (isInstalled) {
    return null;
  }

  const handleInstallClick = async () => {
    if (isIOS) {
      setShowIOSGuide(true);
      return;
    }
    if (isInstallable) {
      setIsInstalling(true);
      await install();
      setIsInstalling(false);
    } else {
      // Fallback instruction dialog for desktop/other browsers
      setShowIOSGuide(true);
    }
  };

  if (variant === 'banner') {
    return (
      <>
        <div className={`p-3 sm:p-4 rounded-2xl bg-surface border border-line tactile-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${className}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gold-wash flex items-center justify-center flex-shrink-0">
              <Smartphone className="w-5 h-5 text-gold-deep" />
            </div>
            <div>
              <h4 className="text-xs sm:text-sm font-bold leading-tight text-ink">Install Kosher Supervisor App</h4>
              <p className="text-[11px] text-ink-soft mt-0.5">
                Fast home-screen access, instant task verification, offline support, and full-screen mobile app experience.
              </p>
            </div>
          </div>
          <button
            onClick={handleInstallClick}
            disabled={isInstalling}
            className="flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white tactile-1 flex-shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isInstalling ? 'Installing...' : 'Install / Download App'}</span>
          </button>
        </div>

        {/* Instructions Dialog */}
        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
            <div className="w-full max-w-sm rounded-2xl bg-surface border border-line p-5 tactile-5 space-y-4 animate-slide-up">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-gold-wash flex items-center justify-center text-gold-deep">
                    <Smartphone className="w-4 h-4" />
                  </div>
                  <h3 className="text-sm font-bold text-ink">
                    {isIOS ? 'Install on iPhone / iPad' : 'Install as Application'}
                  </h3>
                </div>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2.5 text-xs text-ink-soft">
                {isIOS ? (
                  <>
                    <div className="flex items-start gap-2.5 p-2.5 rounded-xl bg-sunken border border-line">
                      <div className="w-5 h-5 rounded-md bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center flex-shrink-0 text-[10px] font-bold">1</div>
                      <p>
                        Tap the <strong className="text-ink inline-flex items-center gap-1"><Share2 className="w-3.5 h-3.5 inline text-gold-deep" /> Share</strong> icon in Safari's bottom toolbar.
                      </p>
                    </div>
                    <div className="flex items-start gap-2.5 p-2.5 rounded-xl bg-sunken border border-line">
                      <div className="w-5 h-5 rounded-md bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center flex-shrink-0 text-[10px] font-bold">2</div>
                      <p>
                        Scroll down and tap <strong className="text-ink inline-flex items-center gap-1"><PlusSquare className="w-3.5 h-3.5 inline text-emerald-600" /> Add to Home Screen</strong>.
                      </p>
                    </div>
                    <div className="flex items-start gap-2.5 p-2.5 rounded-xl bg-sunken border border-line">
                      <div className="w-5 h-5 rounded-md bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center flex-shrink-0 text-[10px] font-bold">3</div>
                      <p>
                        Tap <strong className="text-ink">Add</strong> in the top right. Kosher Supervisor will appear right on your home screen like any native app!
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      To install this app on your phone, tablet, or desktop computer:
                    </p>
                    <div className="p-3 rounded-xl bg-sunken border border-line space-y-1.5">
                      <p className="font-semibold text-ink">Chrome, Edge & Android:</p>
                      <p>Click your browser address bar icon or menu (⋮) and tap <strong>Install Kosher Supervisor</strong>.</p>
                    </div>
                  </>
                )}
              </div>

              <button
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-2 text-xs font-bold rounded-xl bg-sunken hover:brightness-95 text-ink-soft pressable cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  // Header / Topbar button variant
  return (
    <>
      <button
        onClick={handleInstallClick}
        disabled={isInstalling}
        title="Install Kosher Supervisor on your phone or computer"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-bold rounded-xl pressable bg-gradient-to-b from-gold to-gold-deep text-white tactile-1 cursor-pointer shrink-0 ${className}`}
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">{isInstalling ? 'Installing...' : 'Download App'}</span>
        <span className="sm:hidden">Download</span>
      </button>

      {/* Guide Dialog */}
      {showIOSGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-surface border border-line p-5 tactile-5 space-y-4 animate-slide-up">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gold-wash flex items-center justify-center text-gold-deep">
                  <Smartphone className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-ink">
                  {isIOS ? 'Install on iPhone / iPad' : 'Download Application'}
                </h3>
              </div>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="p-1 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs text-ink-soft">
              {isIOS ? (
                <>
                  <div className="flex items-start gap-2.5 p-2.5 rounded-xl bg-sunken border border-line">
                    <div className="w-5 h-5 rounded-md bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center flex-shrink-0 text-[10px] font-bold">1</div>
                    <p>
                      Tap the <strong className="text-ink inline-flex items-center gap-1"><Share2 className="w-3.5 h-3.5 inline text-gold-deep" /> Share</strong> button in Safari's toolbar.
                    </p>
                  </div>
                  <div className="flex items-start gap-2.5 p-2.5 rounded-xl bg-sunken border border-line">
                    <div className="w-5 h-5 rounded-md bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center flex-shrink-0 text-[10px] font-bold">2</div>
                    <p>
                      Scroll down and tap <strong className="text-ink inline-flex items-center gap-1"><PlusSquare className="w-3.5 h-3.5 inline text-emerald-600" /> Add to Home Screen</strong>.
                    </p>
                  </div>
                  <div className="flex items-start gap-2.5 p-2.5 rounded-xl bg-sunken border border-line">
                    <div className="w-5 h-5 rounded-md bg-gradient-to-b from-gold to-gold-deep text-white flex items-center justify-center flex-shrink-0 text-[10px] font-bold">3</div>
                    <p>
                      Tap <strong className="text-ink">Add</strong>. You will now have the full app icon on your home screen!
                    </p>
                  </div>
                </>
              ) : (
                <div className="p-3 rounded-xl bg-sunken border border-line space-y-1.5">
                  <p className="font-semibold text-ink">How to install on Android & Desktop:</p>
                  <p>Click your browser address bar icon or menu (⋮) and select <strong>Install App</strong> or <strong>Add to Home Screen</strong>.</p>
                </div>
              )}
            </div>

            <button
              onClick={() => setShowIOSGuide(false)}
              className="w-full py-2 text-xs font-bold rounded-xl bg-sunken hover:brightness-95 text-ink-soft pressable cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
};

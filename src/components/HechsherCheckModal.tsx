import React, { useState, useRef } from 'react';
import { X, Camera, Check, AlertTriangle, RotateCcw, ShieldCheck } from 'lucide-react';
import { ApprovedIngredient } from '../types';

interface HechsherCheckModalProps {
  ingredient: ApprovedIngredient;
  onClose: () => void;
  onConfirm: (id: string) => void;
  onFlag: (id: string) => void;
}

/**
 * Hechsher camera check — first slice.
 * Mashgiach photographs the product label, compares it side-by-side
 * with the approved record, then confirms the match or flags a
 * discrepancy in one tap. Photo lives in component state only for now
 * (persistence is the next step); the verification status persists
 * through the existing verify endpoint.
 */
export const HechsherCheckModal: React.FC<HechsherCheckModalProps> = ({
  ingredient,
  onClose,
  onConfirm,
  onFlag,
}) => {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPhotoUrl(reader.result as string);
    reader.readAsDataURL(file);
    // Reset so the same file can be re-picked after retake
    e.target.value = '';
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg bg-surface border border-line rounded-t-3xl sm:rounded-3xl tactile-4 max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line/70 sticky top-0 bg-surface z-10">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-gold-deep" />
            <h2 className="text-sm font-extrabold text-ink">Check Hechsher</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-ink-faint hover:bg-sunken cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Ingredient name */}
          <div>
            <p className="text-xs font-bold text-ink">{ingredient.name}</p>
            {ingredient.brandOrSupplier && (
              <p className="text-[11px] text-ink-faint">{ingredient.brandOrSupplier}</p>
            )}
          </div>

          {!photoUrl ? (
            /* Capture step */
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex flex-col items-center justify-center gap-3 py-10 px-4 rounded-2xl border-2 border-dashed border-gold/50 bg-gold-wash/40 hover:bg-gold-wash/70 active:scale-[0.99] transition cursor-pointer"
            >
              <span className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gold to-gold-deep flex items-center justify-center shadow-md">
                <Camera className="w-7 h-7 text-white" />
              </span>
              <span className="text-sm font-bold text-ink">Photograph the label</span>
              <span className="text-[11px] text-ink-faint text-center">
                Aim at the hechsher symbol and product name
              </span>
            </button>
          ) : (
            /* Compare step — side by side */
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {/* Photo */}
                <div className="rounded-2xl overflow-hidden border border-line bg-sunken">
                  <p className="text-[10px] font-black uppercase tracking-wider text-ink-faint px-3 pt-2">
                    Label photo
                  </p>
                  <img
                    src={photoUrl}
                    alt="Product label"
                    className="w-full h-44 object-cover mt-1"
                  />
                </div>
                {/* Approved record */}
                <div className="rounded-2xl border border-line bg-sunken px-3 py-2 space-y-1.5">
                  <p className="text-[10px] font-black uppercase tracking-wider text-ink-faint">
                    Approved record
                  </p>
                  <p className="text-xs font-bold text-ink leading-tight">{ingredient.name}</p>
                  <p className="text-[11px] text-ink-soft">
                    {ingredient.kashrutAgency || 'HKC Approved'}
                  </p>
                  <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-black uppercase bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                    {ingredient.kosherStatus}
                  </span>
                  {ingredient.lotOrBatch && (
                    <p className="text-[10px] font-mono text-ink-faint">
                      Lot: {ingredient.lotOrBatch}
                    </p>
                  )}
                </div>
              </div>

              <p className="text-[11px] text-ink-faint text-center">
                Does the symbol on the label match the approved agency above?
              </p>

              {/* Actions */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => onConfirm(ingredient.id)}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold shadow-sm transition cursor-pointer"
                >
                  <Check className="w-4 h-4" />
                  <span>Match — verify</span>
                </button>
                <button
                  onClick={() => onFlag(ingredient.id)}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 text-white text-xs font-bold shadow-sm transition cursor-pointer"
                >
                  <AlertTriangle className="w-4 h-4" />
                  <span>Flag mismatch</span>
                </button>
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-sunken text-ink-soft text-xs font-semibold hover:bg-line/40 active:scale-95 transition cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Retake photo</span>
              </button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFile}
            className="hidden"
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
};

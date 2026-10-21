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
      <div className="absolute inset-0 bg-scrim backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg bg-surface border border-line rounded-t-2xl sm:rounded-2xl e3 max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line/70 sticky top-0 bg-surface z-10">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-ink-soft" />
            <h2 className="text-sm font-bold text-ink">Check Hechsher</h2>
          </div>
          <button
            onClick={onClose}
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-ink-soft hover:bg-sunken shrink-0 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Ingredient name */}
          <div>
            <p className="text-sm font-bold text-ink">{ingredient.name}</p>
            {ingredient.brandOrSupplier && (
              <p className="text-sm text-ink-soft">{ingredient.brandOrSupplier}</p>
            )}
          </div>

          {!photoUrl ? (
            /* Capture step */
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full flex flex-col items-center justify-center gap-3 py-10 px-4 rounded-2xl border-2 border-dashed active:scale-[0.99] transition cursor-pointer bg-surface border-line-control text-ink hover:bg-sunken"
            >
              <span className="w-14 h-14 rounded-2xl bg-sunken flex items-center justify-center e2">
                <Camera className="w-7 h-7 text-ink" />
              </span>
              <span className="text-sm font-bold text-ink">Photograph the label</span>
              <span className="text-xs text-ink-soft text-center">
                Aim at the hechsher symbol and product name
              </span>
            </button>
          ) : (
            /* Compare step — side by side */
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {/* Photo */}
                <div className="rounded-2xl overflow-hidden border border-line bg-sunken">
                  <p className="text-xs font-semibold uppercase tracking-wider text-ink-soft px-3 pt-2">
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
                  <p className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                    Approved record
                  </p>
                  <p className="text-sm font-bold text-ink leading-tight">{ingredient.name}</p>
                  <p className="text-sm text-ink-soft">
                    {ingredient.kashrutAgency || 'HKC Approved'}
                  </p>
                  <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold uppercase bg-sunken text-ink-soft border border-line">
                    {ingredient.kosherStatus}
                  </span>
                  {ingredient.lotOrBatch && (
                    <p className="text-sm font-mono text-ink-soft">
                      Lot: {ingredient.lotOrBatch}
                    </p>
                  )}
                </div>
              </div>

              <p className="text-sm text-ink-soft text-center">
                Does the symbol on the label match the approved agency above?
              </p>

              {/* Actions */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => onConfirm(ingredient.id)}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl active:scale-95 text-xs font-bold e1 transition cursor-pointer bg-gold-deep text-paper"
                >
                  <Check className="w-4 h-4" />
                  <span>Match — verify</span>
                </button>
                <button
                  onClick={() => onFlag(ingredient.id)}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl active:scale-95 text-xs font-bold e1 transition cursor-pointer bg-surface border border-line-control text-bad hover:bg-sunken"
                >
                  <AlertTriangle className="w-4 h-4" />
                  <span>Flag mismatch</span>
                </button>
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold active:scale-95 transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
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

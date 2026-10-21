import React from 'react';
import { AlertTriangle, Trash2, RotateCcw, X, ShieldAlert } from 'lucide-react';

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string | React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary';
  icon?: 'trash' | 'alert' | 'rotate' | 'shield';
  isLoading?: boolean;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  icon = 'trash',
  isLoading = false,
}) => {
  if (!isOpen) return null;

  const renderIcon = () => {
    switch (icon) {
      case 'trash':
        return <Trash2 className="w-6 h-6" />;
      case 'rotate':
        return <RotateCcw className="w-6 h-6" />;
      case 'shield':
        return <ShieldAlert className="w-6 h-6" />;
      case 'alert':
      default:
        return <AlertTriangle className="w-6 h-6" />;
    }
  };

  const getVariantStyles = () => {
    switch (variant) {
      case 'warning':
        return {
          iconBg: 'bg-warn-bg text-warn',
          btnBg: 'pressable bg-gold-deep text-paper',
        };
      case 'primary':
        return {
          iconBg: 'bg-ok-bg text-ok',
          btnBg: 'pressable bg-gold-deep text-paper',
        };
      case 'danger':
      default:
        return {
          iconBg: 'bg-bad-bg text-bad',
          btnBg: 'pressable bg-bad text-paper',
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim backdrop-blur-sm animate-fade-in">
      <div 
        className="w-full max-w-md rounded-2xl bg-surface border border-line e3 overflow-hidden p-6 animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className={`p-3 rounded-xl shrink-0 ${styles.iconBg}`}>
              {renderIcon()}
            </div>
            <div>
              <h3 className="text-base font-bold text-ink leading-tight">
                {title}
              </h3>
              <div className="mt-2 text-xs sm:text-sm text-ink-soft leading-relaxed whitespace-pre-line">
                {message}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg transition cursor-pointer bg-surface border border-line-control text-ink hover:bg-sunken"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5 pt-4 border-t border-line">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 rounded-xl text-xs font-semibold pressable cursor-pointer disabled:opacity-50 bg-surface border border-line-control text-ink hover:bg-sunken"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
            }}
            disabled={isLoading}
            className={`px-4 py-2 rounded-xl text-xs font-bold tactile-2 cursor-pointer disabled:opacity-50 flex items-center gap-1.5 ${styles.btnBg}`}
          >
            {isLoading ? (
              <span>Processing...</span>
            ) : (
              <span>{confirmText}</span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

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
        return <Trash2 className="w-6 h-6 text-rose-600 dark:text-rose-400" />;
      case 'rotate':
        return <RotateCcw className="w-6 h-6 text-gold-deep dark:text-gold" />;
      case 'shield':
        return <ShieldAlert className="w-6 h-6 text-gold-deep dark:text-gold" />;
      case 'alert':
      default:
        return <AlertTriangle className="w-6 h-6 text-gold-deep dark:text-gold" />;
    }
  };

  const getVariantStyles = () => {
    switch (variant) {
      case 'warning':
        return {
          iconBg: 'bg-gold-wash ring-8 ring-gold-wash/50',
          btnBg: 'pressable bg-gradient-to-b from-gold to-gold-deep text-white',
        };
      case 'primary':
        return {
          iconBg: 'bg-gold-wash ring-8 ring-gold-wash/50',
          btnBg: 'pressable bg-gradient-to-b from-gold to-gold-deep text-white',
        };
      case 'danger':
      default:
        return {
          iconBg: 'bg-rose-100 dark:bg-rose-950/60 ring-8 ring-rose-50 dark:ring-rose-950/30',
          btnBg: 'pressable bg-rose-600 hover:bg-rose-700 text-white',
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#1a120a]/60 backdrop-blur-xs animate-fade-in">
      <div 
        className="w-full max-w-md rounded-2xl bg-surface border border-line tactile-5 overflow-hidden p-6 animate-slide-up"
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
            className="p-1 rounded-lg text-ink-faint hover:text-ink-soft hover:bg-sunken transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5 pt-4 border-t border-line">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-ink-soft bg-sunken hover:brightness-95 pressable cursor-pointer disabled:opacity-50"
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

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
        return <RotateCcw className="w-6 h-6 text-amber-600 dark:text-amber-400" />;
      case 'shield':
        return <ShieldAlert className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />;
      case 'alert':
      default:
        return <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />;
    }
  };

  const getVariantStyles = () => {
    switch (variant) {
      case 'warning':
        return {
          iconBg: 'bg-amber-100 dark:bg-amber-950/60 ring-8 ring-amber-50 dark:ring-amber-950/30',
          btnBg: 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-600/20',
        };
      case 'primary':
        return {
          iconBg: 'bg-blue-100 dark:bg-blue-950/60 ring-8 ring-blue-50 dark:ring-blue-950/30',
          btnBg: 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-600/20',
        };
      case 'danger':
      default:
        return {
          iconBg: 'bg-rose-100 dark:bg-rose-950/60 ring-8 ring-rose-50 dark:ring-rose-950/30',
          btnBg: 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-600/20',
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
      <div 
        className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden p-6 animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className={`p-3 rounded-xl shrink-0 ${styles.iconBg}`}>
              {renderIcon()}
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white leading-tight">
                {title}
              </h3>
              <div className="mt-2 text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-line">
                {message}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100 dark:border-slate-800/80">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-700 dark:text-slate-300 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 transition cursor-pointer disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
            }}
            disabled={isLoading}
            className={`px-4 py-2 rounded-xl text-xs font-bold shadow-md transition active:scale-95 cursor-pointer disabled:opacity-50 flex items-center gap-1.5 ${styles.btnBg}`}
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

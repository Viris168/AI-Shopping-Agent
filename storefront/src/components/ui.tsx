import type { ReactNode } from 'react';
import { statusLabel } from '../format';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  return (
    <div className="notice notice-error" role="alert">
      <span>{typeof error === 'string' ? error : error.message}</span>
      {onRetry && (
        <button type="button" className="btn btn-small btn-ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({ children, tone = 'success' }: { children: ReactNode; tone?: 'success' | 'info' }) {
  return (
    <div className={`notice notice-${tone}`} role="status">
      {children}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  PENDING: 'amber',
  PAID: 'blue',
  PROCESSING: 'blue',
  SHIPPED: 'amber',
  DELIVERED: 'green',
  CANCELLED: 'gray',
  REFUNDED: 'gray',
  REQUESTED: 'amber',
  APPROVED: 'green',
  REJECTED: 'red',
  RECEIVED: 'blue',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${STATUS_TONE[status] ?? 'gray'}`}>{statusLabel(status)}</span>;
}

export function Rating({ value }: { value: number }) {
  return (
    <span className="rating" aria-label={`Rated ${value.toFixed(1)} out of 5`}>
      <span aria-hidden="true">★</span> {value.toFixed(1)}
    </span>
  );
}

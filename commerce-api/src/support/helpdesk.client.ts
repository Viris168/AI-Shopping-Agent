import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { SupportTicket } from '../database/entities.js';

/**
 * Helpdesk webhook settings, read at call time. Unset URL → tickets stay in the database only.
 * Any helpdesk works through this one shape: point HELPDESK_URL at its inbound webhook
 * (Zapier/Make, or a small adapter) and it creates the ticket from the JSON body.
 */
export function helpdeskConfig(): {
  url: string;
  token: string | null;
  timeoutMs: number;
} | null {
  const url = process.env.HELPDESK_URL;
  if (!url) return null;
  if (process.env.NODE_ENV === 'production' && !url.startsWith('https://'))
    throw new Error('HELPDESK_URL must use https in production');
  return {
    url,
    token: process.env.HELPDESK_TOKEN || null,
    // Below agent-service's 10 s commerce timeout: the push runs inside the confirm request.
    timeoutMs: Number(process.env.HELPDESK_TIMEOUT_MS ?? 3000),
  };
}

export class HelpdeskError extends Error {}

/** What the helpdesk receives; field names are the contract with its webhook. */
export function helpdeskPayload(ticket: SupportTicket) {
  return {
    id: ticket.id,
    source: 'ai-assistant',
    subject: ticket.subject,
    summary: ticket.summary,
    priority: ticket.priority,
    contactEmail: ticket.contactEmail,
    userId: ticket.userId,
    conversationId: ticket.conversationId,
    createdAt: ticket.createdAt.toISOString(),
  };
}

@Injectable()
export class HelpdeskClient implements OnModuleInit {
  /** A bad HELPDESK_URL stops the boot instead of failing each push. */
  onModuleInit() {
    helpdeskConfig();
  }

  get enabled(): boolean {
    return helpdeskConfig() !== null;
  }

  /**
   * Creates the ticket in the helpdesk and returns its reference (`id` or `ticketId` in the
   * response, if any). Sends the ticket ID as Idempotency-Key, so a retry after a lost
   * response doesn't open a second ticket on helpdesks that honour it.
   * Throws HelpdeskError on a timeout, network error or non-2xx response.
   */
  async push(ticket: SupportTicket): Promise<string | null> {
    const config = helpdeskConfig();
    if (!config) throw new HelpdeskError('HELPDESK_URL is not set');
    let res: Response;
    try {
      res = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': ticket.id,
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify(helpdeskPayload(ticket)),
        signal: AbortSignal.timeout(config.timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      throw new HelpdeskError(
        err instanceof Error && err.name === 'TimeoutError'
          ? `timed out after ${config.timeoutMs} ms`
          : `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Only the status: the body may echo the shopper's details back.
    if (!res.ok) throw new HelpdeskError(`responded ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    if (body && typeof body === 'object') {
      const ref =
        (body as Record<string, unknown>).id ??
        (body as Record<string, unknown>).ticketId;
      if (typeof ref === 'string' || typeof ref === 'number')
        return String(ref).slice(0, 255);
    }
    return null;
  }
}

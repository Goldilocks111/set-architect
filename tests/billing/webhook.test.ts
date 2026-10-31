import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructEvent = vi.fn();
const store = {
  seen: new Set<string>(),
  hasProcessed: vi.fn(async (id: string) => store.seen.has(id)),
  markProcessed: vi.fn(async (id: string) => void store.seen.add(id)),
  upsertSubscription: vi.fn(async () => {}),
  updateStatusBySubscriptionId: vi.fn(async () => {}),
};

vi.mock('@/lib/billing/stripe', async (orig) => ({
  ...(await orig<typeof import('@/lib/billing/stripe')>()),
  getStripe: () => ({ webhooks: { constructEvent } }),
}));
vi.mock('@/lib/billing/subscription-store', async (orig) => ({
  ...(await orig<typeof import('@/lib/billing/subscription-store')>()),
  supabaseSubscriptionStore: () => store,
}));

import { POST } from '@/app/api/stripe/webhook/route';

const req = (sig: string | null = 'sig') =>
  new Request('http://x/api/stripe/webhook', {
    method: 'POST',
    body: '{}',
    headers: sig ? { 'stripe-signature': sig } : {},
  });

const completed = {
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: { object: { client_reference_id: 'user-1', customer: 'cus_1', subscription: 'sub_1' } },
};

beforeEach(() => {
  store.seen.clear();
  vi.clearAllMocks();
  constructEvent.mockReset();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

describe('stripe webhook', () => {
  it('returns 503 when billing is not configured', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'billing not configured' });
  });

  it('rejects a bad signature with 400', async () => {
    constructEvent.mockImplementation(() => {
      throw new Error('bad sig');
    });
    expect((await POST(req())).status).toBe(400);
    expect(store.upsertSubscription).not.toHaveBeenCalled();
  });

  it('rejects a missing signature header with 400', async () => {
    expect((await POST(req(null))).status).toBe(400);
  });

  it('upserts the subscription on checkout.session.completed', async () => {
    constructEvent.mockReturnValue(completed);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(store.upsertSubscription).toHaveBeenCalledWith({
      user_id: 'user-1',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      status: 'active',
      plan: 'pro',
    });
  });

  it('is a no-op when the same event id is replayed', async () => {
    constructEvent.mockReturnValue(completed);
    await POST(req());
    const second = await POST(req());
    expect(second.status).toBe(200);
    expect(store.upsertSubscription).toHaveBeenCalledTimes(1);
  });

  it('does not mark the event processed when handling fails, so the retry is re-attempted', async () => {
    constructEvent.mockReturnValue(completed);
    store.upsertSubscription.mockRejectedValueOnce(new Error('db down'));
    expect((await POST(req())).status).toBe(500);
    expect(store.markProcessed).not.toHaveBeenCalled();
    expect((await POST(req())).status).toBe(200);
    expect(store.upsertSubscription).toHaveBeenCalledTimes(2);
    expect(store.markProcessed).toHaveBeenCalledWith('evt_1');
  });

  it('returns 500 and stays retryable if markProcessed fails', async () => {
    constructEvent.mockReturnValue(completed);
    store.markProcessed.mockRejectedValueOnce(new Error('db down'));
    expect((await POST(req())).status).toBe(500);
    expect((await POST(req())).status).toBe(200);
  });

  it('syncs status on customer.subscription.deleted', async () => {
    constructEvent.mockReturnValue({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
    await POST(req());
    expect(store.updateStatusBySubscriptionId).toHaveBeenCalledWith('sub_1', 'canceled');
  });
});

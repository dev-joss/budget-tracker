import { app } from '@root/app';
import { API_PREFIX } from '@root/config';
import request from 'supertest';

describe('POST /webhooks/plaid', () => {
  it('acknowledges a verified webhook without a matching Item', async () => {
    const response = await request(app)
      .post(`${API_PREFIX}/webhooks/plaid`)
      .set('Plaid-Verification', 'verified-token')
      .send({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'unknown-item' });

    expect(response.status).toBe(200);
    expect(response.body.response).toEqual({ received: true });
  });

  it('acknowledges a verified webhook type without an Item ID', async () => {
    const response = await request(app)
      .post(`${API_PREFIX}/webhooks/plaid`)
      .set('Plaid-Verification', 'verified-token')
      .send({ webhook_type: 'ASSETS', webhook_code: 'PRODUCT_READY' });

    expect(response.status).toBe(200);
  });

  it('rejects a webhook without a verification header', async () => {
    const response = await request(app).post(`${API_PREFIX}/webhooks/plaid`).send({ webhook_type: 'TRANSACTIONS' });
    expect(response.status).toBe(500);
  });
});

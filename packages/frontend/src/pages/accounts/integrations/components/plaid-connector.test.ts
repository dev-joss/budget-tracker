import { flushPromises, mount } from '@vue/test-utils';

import type { PlaidLinkMetadata } from '@/lib/plaid-link';

import PlaidConnector from './plaid-connector.vue';

const {
  mockCreatePlaidLink,
  mockCreatePlaidLinkToken,
  mockDestroy,
  mockOpen,
  plaidCallbacks,
} = vi.hoisted(() => ({
  mockCreatePlaidLink: vi.fn(),
  mockCreatePlaidLinkToken: vi.fn(),
  mockDestroy: vi.fn(),
  mockOpen: vi.fn(),
  plaidCallbacks: {
    onExit: undefined as (() => void) | undefined,
    onSuccess: undefined as ((publicToken: string, metadata: PlaidLinkMetadata) => void) | undefined,
  },
}));

vi.mock('@/api/bank-data-providers', () => ({
  connectProvider: vi.fn(),
  createPlaidLinkToken: mockCreatePlaidLinkToken,
  getAvailableAccounts: vi.fn(),
  syncSelectedAccounts: vi.fn(),
}));

vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addErrorNotification: vi.fn() }),
}));

vi.mock('@/lib/plaid-link', () => ({
  loadPlaidLink: vi.fn().mockResolvedValue(undefined),
  createPlaidLink: mockCreatePlaidLink,
}));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('PlaidConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plaidCallbacks.onExit = undefined;
    plaidCallbacks.onSuccess = undefined;
    mockCreatePlaidLinkToken.mockResolvedValue({ linkToken: 'link-token' });
    mockCreatePlaidLink.mockImplementation(
      (options: {
        onExit?: () => void;
        onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
      }) => {
        plaidCallbacks.onExit = options.onExit;
        plaidCallbacks.onSuccess = options.onSuccess;
        return { destroy: mockDestroy, open: mockOpen };
      },
    );
  });

  it('keeps the Plaid Link handler alive until the connector unmounts', async () => {
    const wrapper = mount(PlaidConnector, {
      global: { stubs: { Callout: true, AccountSelectionList: true } },
    });

    await wrapper.findAll('button').at(1)!.trigger('click');
    await flushPromises();

    expect(mockOpen).toHaveBeenCalledOnce();
    expect(mockDestroy).not.toHaveBeenCalled();

    plaidCallbacks.onSuccess?.('public-token', { accounts: [], institution: null });
    expect(mockDestroy).not.toHaveBeenCalled();

    plaidCallbacks.onExit?.();
    expect(mockDestroy).not.toHaveBeenCalled();

    wrapper.unmount();
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  it('does not open Plaid Link when token creation fails', async () => {
    mockCreatePlaidLinkToken.mockRejectedValue(new Error('Unavailable'));
    const wrapper = mount(PlaidConnector, {
      global: { stubs: { Callout: true, AccountSelectionList: true } },
    });

    await wrapper.findAll('button').at(1)!.trigger('click');
    await flushPromises();

    expect(mockOpen).not.toHaveBeenCalled();
  });
});

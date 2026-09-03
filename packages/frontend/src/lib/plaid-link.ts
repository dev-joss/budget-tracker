export interface PlaidLinkMetadata {
  institution: { institution_id: string; name: string } | null;
  accounts: Array<{ id: string; name: string; mask: string | null }>;
}

interface PlaidLinkOptions {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
  onExit?: (error: unknown) => void;
}

export interface PlaidLinkHandler {
  open: () => void;
  destroy: () => void;
}

declare global {
  interface Window {
    Plaid?: { create: (options: PlaidLinkOptions) => PlaidLinkHandler };
  }
}

const SCRIPT_ID = 'plaid-link-script';
const SCRIPT_URL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
let loadPromise: Promise<void> | null = null;

export const loadPlaidLink = (): Promise<void> => {
  if (window.Plaid) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing || document.createElement('script');
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load Plaid Link.')), { once: true });
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    loadPromise = null;
    throw error;
  });

  return loadPromise;
};

export const createPlaidLink = (options: PlaidLinkOptions): PlaidLinkHandler => {
  if (!window.Plaid) throw new Error('Plaid Link is not loaded.');
  return window.Plaid.create(options);
};

import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';

import AddIntegrationDialog from './add-integration-dialog.vue';

vi.mock('@/components/common/responsive-dialog.vue', () => ({
  default: defineComponent({
    name: 'ResponsiveDialogStub',
    props: {
      modal: { type: Boolean, default: true },
      open: { type: Boolean, default: false },
    },
    setup(_props, { slots }) {
      return () => h('div', slots.default?.());
    },
  }),
}));

vi.mock('@/lib/posthog', () => ({ trackAnalyticsEvent: vi.fn() }));

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('AddIntegrationDialog', () => {
  it('uses a stable non-modal root for the complete connection flow', async () => {
    const wrapper = mount(AddIntegrationDialog, {
      props: { open: true, providers: [] },
      global: {
        stubs: {
          BankProviderLogo: true,
          ResponsiveTooltip: true,
        },
      },
    });
    const dialog = wrapper.findComponent({ name: 'ResponsiveDialogStub' });
    const dialogInstance = dialog.vm;

    expect(dialog.props('modal')).toBe(false);

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });

    expect(wrapper.findComponent({ name: 'ResponsiveDialogStub' }).vm).toBe(dialogInstance);
    expect(wrapper.findComponent({ name: 'ResponsiveDialogStub' }).props('modal')).toBe(false);
  });
});

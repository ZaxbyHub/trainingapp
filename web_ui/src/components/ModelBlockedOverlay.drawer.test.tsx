/**
 * Phase-3 review F1: the model-gate overlay (an aria-modal alertdialog inside
 * <main>, z 200) and the AppShell nav drawer (an aria-modal dialog, z 300) can
 * be open together at <= 768px. The overlay's focus trap must only act on Tab
 * presses that start INSIDE the overlay; a Shift+Tab inside the open drawer
 * must stay in the drawer, never jump to the overlay under the drawer's scrim.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell, DRAWER_MEDIA_QUERY, SideNav } from '../ui';
import { ModelBlockedOverlay } from './ModelBlockedOverlay';
import type { ReadinessResult } from '../lib/llm/model-readiness';

const readiness: ReadinessResult = {
  ready: false,
  checks: {
    webgpu: true,
    memory: { availableBytes: 8e9, requiredBytes: 4e9, sufficient: true, tier: 'HIGH' as const },
    modelCached: false,
  },
  failures: ['Model not downloaded'],
  recommendations: [],
};

const original = window.matchMedia;
function drawerWidth(): void {
  window.matchMedia = ((query: string) => ({
    matches: query === DRAWER_MEDIA_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  window.matchMedia = original;
});

function renderShellWithGate() {
  return render(
    <AppShell
      productName="TrainingApp"
      collapsed={false}
      onToggleCollapsed={() => {}}
      sidebar={
        <SideNav
          label="Main navigation"
          items={[
            { id: 'chat', label: 'Chat', icon: 'message-square' },
            { id: 'documents', label: 'Documents', icon: 'file-text' },
            { id: 'settings', label: 'Settings', icon: 'settings' },
          ]}
          activeId="chat"
          onNavigate={() => {}}
        />
      }
    >
      <div style={{ position: 'relative' }}>
        <ModelBlockedOverlay
          readinessResult={readiness}
          browserEngine="webllm"
          modelLoadingProgress={0}
          onRetry={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      </div>
    </AppShell>
  );
}

describe('model-gate overlay + open nav drawer (phase 3 review F1)', () => {
  it('Shift+Tab and Tab inside the open drawer keep focus in the drawer', async () => {
    const user = userEvent.setup();
    drawerWidth();
    renderShellWithGate();
    // The overlay grabbed focus on mount, as before.
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    const close = within(drawer).getByRole('button', { name: 'Close navigation' });
    const chat = within(drawer).getByRole('button', { name: 'Chat' });
    const settings = within(drawer).getByRole('button', { name: 'Settings' });
    expect(chat).toHaveFocus();

    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab({ shift: true }); // wraps inside the drawer
    expect(settings).toHaveFocus();
    expect(drawer.contains(document.activeElement)).toBe(true);

    await user.tab(); // wraps forward to the first drawer control
    expect(close).toHaveFocus();
    await user.tab();
    expect(chat).toHaveFocus();
  });

  it('the gate does not trap Tab or Shift+Tab (the drawer / shell nav stay reachable)', () => {
    drawerWidth();
    renderShellWithGate();
    const overlay = screen.getByRole('alertdialog');
    const buttons = within(overlay).getAllByRole('button');
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    expect(fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(true);
  });
});

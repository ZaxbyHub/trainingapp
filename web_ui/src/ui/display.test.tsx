import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  KeyValueList,
  Kbd,
  PageHeader,
  ProgressBar,
  Section,
  Skeleton,
  StatusPill,
} from './index';

describe('Section / Card / PageHeader', () => {
  it('Section is a labelled region named by its heading', () => {
    render(
      <Section title="Model & connection" description="Where answers come from">
        <p>body</p>
      </Section>
    );
    const region = screen.getByRole('region', { name: 'Model & connection' });
    expect(region.tagName).toBe('SECTION');
    expect(within(region).getByRole('heading', { level: 2, name: 'Model & connection' })).toBeInTheDocument();
    expect(within(region).getByText('body')).toBeInTheDocument();
  });

  it('Section honours headingLevel', () => {
    render(
      <Section title="Sub" headingLevel={3}>
        x
      </Section>
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Sub' })).toBeInTheDocument();
  });

  it('PageHeader renders an h1 and its actions', () => {
    render(<PageHeader title="Documents" description="3 files" actions={<Button>Upload</Button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    expect(screen.getByText('3 files')).toBeInTheDocument();
  });

  it('Card renders children', () => {
    render(<Card>hello</Card>);
    expect(screen.getByText('hello')).toHaveClass('ui-card');
  });
});

describe('Badge / StatusPill', () => {
  it('Badge always carries text', () => {
    render(<Badge tone="success">Ready</Badge>);
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('StatusPill pairs an aria-hidden icon with visible text', () => {
    render(<StatusPill status="danger">Failed</StatusPill>);
    const pill = screen.getByText('Failed');
    expect(pill).toBeInTheDocument();
    expect(pill.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Banner', () => {
  it.each([
    ['danger', 'alert'],
    ['warning', 'alert'],
    ['info', 'status'],
    ['success', 'status'],
  ] as const)('tone %s uses role=%s', (tone, role) => {
    render(
      <Banner tone={tone} title="Heads up">
        details
      </Banner>
    );
    const banner = screen.getByRole(role);
    expect(banner).toHaveTextContent('Heads up');
    expect(banner).toHaveTextContent('details');
  });

  it('renders an action', () => {
    render(<Banner action={<Button>Retry</Button>}>Connection failed</Banner>);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('ProgressBar', () => {
  it('exposes determinate value, min and max', () => {
    render(<ProgressBar label="Indexing" value={40} />);
    const bar = screen.getByRole('progressbar', { name: 'Indexing' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('omits aria-valuenow when indeterminate', () => {
    render(<ProgressBar label="Loading" />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).not.toHaveAttribute('aria-valuenow');
  });

  it('clamps out-of-range values visually', () => {
    const { container } = render(<ProgressBar label="x" value={250} />);
    expect(container.querySelector<HTMLElement>('.ui-progress__fill')?.style.width).toBe('100%');
  });
});

describe('Skeleton / EmptyState / KeyValueList / Kbd', () => {
  it('Skeleton is hidden from assistive tech', () => {
    const { container } = render(<Skeleton width={120} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('EmptyState shows title, description and action', () => {
    render(<EmptyState icon="search" title="No documents" description="Upload one" action={<Button>Upload</Button>} />);
    expect(screen.getByRole('heading', { name: 'No documents' })).toBeInTheDocument();
    expect(screen.getByText('Upload one')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
  });

  it('KeyValueList renders a description list pairing terms with values', () => {
    const { container } = render(
      <KeyValueList
        items={[
          { label: 'Model', value: 'gemma-4-e2b-it' },
          { label: 'Engine', value: 'wllama' },
        ]}
      />
    );
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(container.querySelectorAll('dd')).toHaveLength(2);
    expect(screen.getByText('Model').nextElementSibling).toHaveTextContent('gemma-4-e2b-it');
  });

  it('Kbd renders a kbd element', () => {
    render(<Kbd>Ctrl</Kbd>);
    expect(screen.getByText('Ctrl').tagName).toBe('KBD');
  });
});

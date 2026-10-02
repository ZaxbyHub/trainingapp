import { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  ICON_NAMES,
  Icon,
  IconButton,
  Kbd,
  KeyValueList,
  PageHeader,
  PasswordInput,
  ProgressBar,
  RadioCardGroup,
  SegmentedControl,
  Section,
  Select,
  Skeleton,
  StatusPill,
  Switch,
  Tabs,
  TextInput,
  Tooltip,
} from '../index';
import './gallery.css';

/** LUMEN-GALLERY-DEV-ONLY: marker string used to prove this chunk is absent from production builds. */
export const GALLERY_MARKER = 'LUMEN-GALLERY-DEV-ONLY';

export function Gallery() {
  const [theme, setTheme] = useState<'light' | 'dark'>(
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
  );
  const [source, setSource] = useState('local');
  const [seg, setSeg] = useState('a');
  const [tab, setTab] = useState('one');
  const [dialog, setDialog] = useState(false);

  const setThemeAttr = (t: 'light' | 'dark') => {
    document.documentElement.setAttribute('data-theme', t);
    setTheme(t);
  };

  return (
    <div className="gallery" data-gallery={GALLERY_MARKER}>
      <PageHeader
        title="Lumen gallery"
        description="Dev-only component gallery (not part of production builds)."
        actions={
          <SegmentedControl
            legend="Theme"
            hideLegend
            value={theme}
            onChange={(v) => setThemeAttr(v === 'dark' ? 'dark' : 'light')}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        }
      />

      <Section title="Buttons">
        <div className="gallery__row">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" loading>
            Loading
          </Button>
          <Button aria-disabled="true">Disabled</Button>
          <Button size="sm">Small</Button>
          <IconButton icon="plus" aria-label="Add" />
        </div>
      </Section>

      <Section title="Icons">
        <div className="gallery__row">
          {ICON_NAMES.map((n) => (
            <Tooltip key={n} content={n}>
              <span className="gallery__icon" tabIndex={0}>
                <Icon name={n} />
              </span>
            </Tooltip>
          ))}
        </div>
      </Section>

      <Section title="Form controls">
        <div className="gallery__grid">
          <Field label="Base URL" help="OpenAI-compatible endpoint">
            {(c) => <TextInput {...c} placeholder="http://127.0.0.1:1234/v1" />}
          </Field>
          <Field label="API key" error="Required">
            {(c) => <PasswordInput {...c} />}
          </Field>
          <Field label="Protocol">
            {(c) => (
              <Select {...c}>
                <option>OpenAI-compatible</option>
                <option>Anthropic-compatible</option>
              </Select>
            )}
          </Field>
          <Switch label="Use my documents (grounded)" description="Answers cite your files" defaultChecked />
          <Checkbox label="Remember this choice" />
          <SegmentedControl
            legend="View"
            value={seg}
            onChange={setSeg}
            options={[
              { value: 'a', label: 'List' },
              { value: 'b', label: 'Grid' },
            ]}
          />
        </div>
        <RadioCardGroup
          legend="Generator source"
          value={source}
          onChange={setSource}
          options={[
            { value: 'local', label: 'Built-in model', description: 'Runs on this device' },
            { value: 'server', label: 'Local or network server', description: 'LM Studio, Ollama, llama.cpp' },
            { value: 'cloud', label: 'Cloud provider', description: 'OpenAI or Anthropic', disabled: true },
          ]}
        />
      </Section>

      <Section title="Status">
        <div className="gallery__row">
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <StatusPill status="success">Ready</StatusPill>
          <StatusPill status="warning">Not cached</StatusPill>
          <StatusPill status="danger">Failed</StatusPill>
          <StatusPill status="info">Syncing</StatusPill>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </div>
        <div className="gallery__stack">
          <Banner tone="info" title="Info">
            A neutral heads-up.
          </Banner>
          <Banner tone="success" title="Connected">
            Test connection succeeded.
          </Banner>
          <Banner tone="warning" title="Slow">
            Using the CPU engine.
          </Banner>
          <Banner tone="danger" title="Connection failed" action={<Button size="sm">Retry</Button>}>
            Could not reach the server.
          </Banner>
          <ProgressBar label="Indexing" value={60} />
          <ProgressBar label="Loading" />
          <Skeleton width={240} />
        </div>
      </Section>

      <Section title="Navigation and data">
        <Tabs
          label="Library"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'one', label: 'Documents', panel: <KeyValueList items={[{ label: 'Files', value: '3' }, { label: 'Chunks', value: '128' }]} /> },
            { id: 'two', label: 'Training packs', panel: <p>Packs go here.</p> },
          ]}
        />
        <Card>
          <EmptyState icon="search" title="No documents yet" description="Upload a PDF, DOCX, or text file." action={<Button variant="primary">Upload</Button>} />
        </Card>
      </Section>

      <Section title="Dialog">
        <Button onClick={() => setDialog(true)}>Open dialog</Button>
        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Delete conversation?"
          footer={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>
                Delete
              </Button>
            </>
          }
        >
          This cannot be undone.
        </Dialog>
      </Section>
    </div>
  );
}

/**
 * EmptyState - Displays contextual empty state messages with optional actions.
 * Used when there's no data or content to show in a section.
 */

import React from 'react';

type EmptyStateVariant = 'no-documents' | 'no-results' | 'no-chat-history' | 'generic';

interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title?: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface VariantConfig {
  icon: React.ReactElement;
  defaultTitle: string;
  defaultDescription: string;
}

const variantConfigs: Record<EmptyStateVariant, VariantConfig> = {
  'no-documents': {
    icon: (
      <svg
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    defaultTitle: 'No documents yet',
    defaultDescription: 'Upload your first document to get started with intelligent Q&A.',
  },
  'no-results': {
    icon: (
      <svg
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
    ),
    defaultTitle: 'No results found',
    defaultDescription: 'Try adjusting your search terms or filters to find what you\'re looking for.',
  },
  'no-chat-history': {
    icon: (
      <svg
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <line x1="9" y1="9" x2="15" y2="9" />
        <line x1="9" y1="13" x2="12" y2="13" />
      </svg>
    ),
    defaultTitle: 'No chat history',
    defaultDescription: 'Start a conversation to see your chat history here.',
  },
  'generic': {
    icon: (
      <svg
        width="64"
        height="64"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    ),
    defaultTitle: 'Nothing here',
    defaultDescription: 'There\'s nothing to display at the moment.',
  },
};

/**
 * EmptyState component for displaying contextual empty states.
 * Supports multiple variants with appropriate icons and default messages.
 *
 * @example
 * // Default empty state
 * <EmptyState variant="no-documents" />
 *
 * // Custom title and description
 * <EmptyState
 *   variant="no-results"
 *   title="No matches"
 *   description="Try different keywords"
 * />
 *
 * // With action button
 * <EmptyState
 *   variant="no-documents"
 *   action={{ label: 'Upload', onClick: handleUpload }}
 * />
 */
export function EmptyState({
  variant = 'generic',
  title,
  description,
  action,
}: EmptyStateProps): React.ReactElement {
  const config = variantConfigs[variant];

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--spacing-xxxl) var(--spacing-xl)',
    textAlign: 'center',
    minHeight: '200px',
  };

  const iconContainerStyle: React.CSSProperties = {
    color: 'var(--color-text-muted)',
    marginBottom: 'var(--spacing-xl)',
    opacity: 0.6,
  };

  const titleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-h1)',
    fontWeight: 600,
    color: 'var(--color-text-on-secondary)',
    margin: '0 0 var(--spacing-md) 0',
  };

  const descriptionStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-body)',
    color: 'var(--color-text-muted)',
    margin: '0 0 var(--spacing-xl) 0',
    maxWidth: '320px',
    lineHeight: 1.5,
  };

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--spacing-sm)',
    padding: 'var(--spacing-md) var(--spacing-xl)',
    fontSize: 'var(--font-size-body)',
    fontWeight: 500,
    color: 'var(--color-text-on-primary)',
    backgroundColor: 'var(--color-primary)',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  };

  const handleButtonMouseEnter = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.currentTarget.style.backgroundColor = 'var(--color-primary-hover)';
  };

  const handleButtonMouseLeave = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.currentTarget.style.backgroundColor = 'var(--color-primary)';
  };

  return (
    <div
      style={containerStyle}
      role="status"
    >
      <div style={iconContainerStyle}>
        {config.icon}
      </div>
      <h2 style={titleStyle}>
        {title || config.defaultTitle}
      </h2>
      <p style={descriptionStyle}>
        {description || config.defaultDescription}
      </p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={buttonStyle}
          onMouseEnter={handleButtonMouseEnter}
          onMouseLeave={handleButtonMouseLeave}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export default EmptyState;

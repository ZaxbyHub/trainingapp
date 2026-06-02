/**
 * EmptyState Tests
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, test, expect, vi } from 'vitest';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  test('role="status" is set on container', () => {
    render(<EmptyState />);
    
    const container = screen.getByRole('status');
    expect(container).toBeInTheDocument();
  });

  test('Renders no-documents variant with correct default text', () => {
    render(<EmptyState variant="no-documents" />);
    
    expect(screen.getByText('No documents yet')).toBeInTheDocument();
    expect(screen.getByText('Upload your first document to get started with intelligent Q&A.')).toBeInTheDocument();
  });

  test('Renders no-results variant with correct default text', () => {
    render(<EmptyState variant="no-results" />);
    
    expect(screen.getByText('No results found')).toBeInTheDocument();
    expect(screen.getByText("Try adjusting your search terms or filters to find what you're looking for.")).toBeInTheDocument();
  });

  test('Renders no-chat-history variant with correct default text', () => {
    render(<EmptyState variant="no-chat-history" />);
    
    expect(screen.getByText('No chat history')).toBeInTheDocument();
    expect(screen.getByText('Start a conversation to see your chat history here.')).toBeInTheDocument();
  });

  test('Renders generic variant with correct default text', () => {
    render(<EmptyState variant="generic" />);
    
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText("There's nothing to display at the moment.")).toBeInTheDocument();
  });

  test('Action button renders and fires onClick', () => {
    const handleClick = vi.fn();
    render(
      <EmptyState
        variant="no-documents"
        action={{ label: 'Upload Document', onClick: handleClick }}
      />
    );

    const button = screen.getByRole('button', { name: 'Upload Document' });
    expect(button).toBeInTheDocument();
    
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  test('Action button is not rendered when action prop is omitted', () => {
    render(<EmptyState variant="no-documents" />);
    
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(0);
  });

  test('Custom title overrides default title', () => {
    render(
      <EmptyState
        variant="no-documents"
        title="Custom Title"
      />
    );

    expect(screen.getByText('Custom Title')).toBeInTheDocument();
    expect(screen.queryByText('No documents yet')).not.toBeInTheDocument();
  });

  test('Custom description overrides default description', () => {
    render(
      <EmptyState
        variant="no-documents"
        description="Custom description text"
      />
    );

    expect(screen.getByText('Custom description text')).toBeInTheDocument();
    expect(screen.queryByText('Upload your first document to get started with intelligent Q&A.')).not.toBeInTheDocument();
  });

  test('Both custom title and description are applied', () => {
    render(
      <EmptyState
        variant="no-documents"
        title="My Custom Title"
        description="My custom description here"
      />
    );

    expect(screen.getByText('My Custom Title')).toBeInTheDocument();
    expect(screen.getByText('My custom description here')).toBeInTheDocument();
  });

  test('Renders icon for each variant', () => {
    const variants: Array<'no-documents' | 'no-results' | 'no-chat-history' | 'generic'> = [
      'no-documents',
      'no-results',
      'no-chat-history',
      'generic'
    ];

    for (const variant of variants) {
      const { unmount } = render(<EmptyState variant={variant} />);
      // Check that SVG icons are rendered (aria-hidden SVGs)
      const icons = document.querySelectorAll('svg[aria-hidden="true"]');
      expect(icons.length).toBeGreaterThan(0);
      unmount();
    }
  });

  test('Default variant is generic', () => {
    render(<EmptyState />);
    
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText("There's nothing to display at the moment.")).toBeInTheDocument();
  });
});

import { useState, useRef, useEffect } from 'react';
import { formatRelativeTime } from '../utils/relativeTime';

interface SidebarConversationItemProps {
  id: string;
  title: string;
  timestamp: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
}

export function SidebarConversationItem({
  id,
  title,
  timestamp,
  isSelected,
  onSelect,
  onRename,
  onDelete,
}: SidebarConversationItemProps) {
  const [hovered, setHovered] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const [menuHoverIndex, setMenuHoverIndex] = useState<number | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isRenaming) {
      setEditTitle(title);
    }
  }, [title, isRenaming]);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        kebabRef.current &&
        !kebabRef.current.contains(target)
      ) {
        setIsMenuOpen(false);
        setIsDeleteConfirmOpen(false);
      }
    };

    if (isMenuOpen || isDeleteConfirmOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [isMenuOpen, isDeleteConfirmOpen]);

  const handleKebabClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setIsMenuOpen((prev) => !prev);
    setIsDeleteConfirmOpen(false);
  };

  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(false);
    setIsDeleteConfirmOpen(false);
    setEditTitle(title);
    setIsRenaming(true);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMenuOpen(false);
    setIsDeleteConfirmOpen(true);
  };

  const handleConfirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(id);
    setIsDeleteConfirmOpen(false);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDeleteConfirmOpen(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const trimmed = editTitle.trim();
      onRename(id, trimmed || title);
      setIsRenaming(false);
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
    }
  };

  const handleRenameBlur = () => {
    const trimmed = editTitle.trim();
    if (trimmed !== title && trimmed !== '') {
      onRename(id, trimmed);
    }
    setIsRenaming(false);
  };

  const handleRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isRenaming && !isMenuOpen && !isDeleteConfirmOpen) {
      e.preventDefault();
      onSelect(id);
    }
    if (e.key === 'Escape' && (isMenuOpen || isDeleteConfirmOpen)) {
      setIsMenuOpen(false);
      setIsDeleteConfirmOpen(false);
    }
  };

  const getMenuItemStyle = (index: number): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: 'var(--spacing-sm) var(--spacing-md)',
    textAlign: 'left',
    backgroundColor: menuHoverIndex === index ? 'var(--color-primary)' : 'transparent',
    color: menuHoverIndex === index ? 'var(--color-text-on-primary)' : 'var(--color-text-primary)',
    border: 'none',
    fontSize: 'var(--font-size-small)',
    fontFamily: 'var(--font-family)',
    cursor: 'pointer',
    transition: 'background-color 100ms ease',
  });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!isRenaming && !isMenuOpen && !isDeleteConfirmOpen) {
          onSelect(id);
        }
      }}
      onKeyDown={handleRootKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-current={isSelected ? 'page' : undefined}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        padding: 'var(--spacing-sm) var(--spacing-md)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: isSelected
          ? 'var(--color-primary)'
          : hovered
          ? 'var(--color-secondary)'
          : 'transparent',
        color: isSelected
          ? 'var(--color-text-on-primary)'
          : 'var(--color-text-on-bubble-assistant)',
        cursor: isRenaming ? 'default' : 'pointer',
        textAlign: 'left',
        transition: 'background-color 150ms ease',
        gap: 'var(--spacing-xs)',
        outline: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', width: '100%' }}>
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            aria-label="Edit conversation title"
            style={{
              flex: 1,
              fontSize: 'var(--font-size-small)',
              fontFamily: 'var(--font-family)',
              backgroundColor: 'transparent',
              border: '1px solid var(--color-primary)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px var(--spacing-xs)',
              color: isSelected ? 'var(--color-text-on-primary)' : 'var(--color-text-primary)',
              outline: 'none',
            }}
          />
        ) : (
          <span style={{
            flex: 1, fontSize: 'var(--font-size-small)', fontFamily: 'var(--font-family)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {title || 'Untitled conversation'}
          </span>
        )}
        {!isRenaming && (
          <button
            ref={kebabRef}
            type="button"
            onClick={handleKebabClick}
            aria-label="Conversation options"
            aria-haspopup="menu"
            aria-expanded={isMenuOpen || isDeleteConfirmOpen}
            style={{
              opacity: hovered ? 1 : 0,
              transition: 'opacity 150ms ease',
              backgroundColor: 'transparent', border: 'none', color: 'inherit',
              fontSize: '20px', lineHeight: 1, padding: 'var(--spacing-xs)',
              cursor: 'pointer', borderRadius: 'var(--radius-sm)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '24px',
            }}
          >
            ⋯
          </button>
        )}
      </div>
      <span style={{
        fontSize: 'var(--font-size-small)', fontFamily: 'var(--font-family)',
        color: isSelected ? 'var(--color-text-on-primary)' : 'var(--color-text-muted)', opacity: 0.7,
      }}>
        {formatRelativeTime(timestamp)}
      </span>
      {(isMenuOpen || isDeleteConfirmOpen) && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Conversation actions"
          style={{
            position: 'absolute', top: 'calc(100% + var(--spacing-xs))', right: 'var(--spacing-sm)',
            backgroundColor: 'var(--color-secondary)', borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)', minWidth: '180px', zIndex: 20,
            border: '1px solid var(--color-text-muted)', overflow: 'hidden',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {isDeleteConfirmOpen ? (
            <div style={{ padding: 'var(--spacing-md)', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }} role="alert">
              <div style={{ fontSize: 'var(--font-size-small)', color: 'var(--color-text-primary)', fontWeight: 500 }}>
                Delete this conversation?
              </div>
              <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
                <button
                  role="menuitem"
                  onClick={handleConfirmDelete}
                  style={{
                    flex: 1, padding: 'var(--spacing-sm)',
                    backgroundColor: 'var(--color-danger)', color: 'var(--color-text-on-primary)',
                    border: 'none', borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-small)', cursor: 'pointer', fontWeight: 500,
                  }}
                >
                  Confirm
                </button>
                <button
                  role="menuitem"
                  onClick={handleCancelDelete}
                  style={{
                    flex: 1, padding: 'var(--spacing-sm)',
                    backgroundColor: 'transparent', color: 'var(--color-text-muted)',
                    border: '1px solid var(--color-text-muted)', borderRadius: 'var(--radius-sm)',
                    fontSize: 'var(--font-size-small)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button role="menuitem" onClick={handleRenameClick}
                onMouseEnter={() => setMenuHoverIndex(0)} onMouseLeave={() => setMenuHoverIndex(null)}
                style={getMenuItemStyle(0)}>
                Rename
              </button>
              <button role="menuitem" onClick={handleDeleteClick}
                onMouseEnter={() => setMenuHoverIndex(1)} onMouseLeave={() => setMenuHoverIndex(null)}
                style={{ ...getMenuItemStyle(1), color: menuHoverIndex === 1 ? 'var(--color-text-on-primary)' : 'var(--color-danger)' }}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

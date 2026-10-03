import { useState, useRef, useEffect } from 'react';
import { formatRelativeTime } from '../utils/relativeTime';
import { Button, Icon } from '../ui';
import { cx } from '../ui/cx';

interface SidebarConversationItemProps {
  id: string;
  title: string;
  timestamp: string;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
}

/**
 * One conversation row. Styling lives in layouts/shell.css (Lumen tokens only):
 * hover is --bg-hover, selected is --bg-selected + weight 600 (never color
 * alone), focus is the outline ring, and the options button is revealed on
 * hover / keyboard focus (always shown on touch devices).
 */
export function SidebarConversationItem({
  id,
  title,
  timestamp,
  isSelected,
  onSelect,
  onRename,
  onDelete,
}: SidebarConversationItemProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [editTitle, setEditTitle] = useState(title);

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

  // Menu-button pattern (PR #147 review PRR-026): opening the menu moves focus to
  // its first item; ArrowUp/ArrowDown/Home/End move between items (see
  // handleMenuKeyDown); Escape, Cancel and the Delete -> confirm swap hand focus
  // back to the options button instead of letting it fall to <body> when the
  // focused item unmounts (PRR-002).
  useEffect(() => {
    if (isMenuOpen) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [isMenuOpen]);

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
    // The focused "Delete" item is about to unmount: keep focus on the row.
    kebabRef.current?.focus();
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
    kebabRef.current?.focus();
    setIsDeleteConfirmOpen(false);
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.findIndex((el) => el === document.activeElement);
    const last = items.length - 1;
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'ArrowDown' ? (at < 0 || at === last ? 0 : at + 1) : at <= 0 ? last : at - 1;
    items[next].focus();
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const trimmed = editTitle.trim();
      onRename(id, trimmed || title);
      setIsRenaming(false);
    } else if (e.key === 'Escape') {
      // Consumed here: an enclosing drawer must not also close.
      e.stopPropagation();
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

  // Escape closes this row's menu or delete confirmation only. Selection is the
  // native <button> below (Enter/Space activate it natively), so no key handler
  // here can swallow Enter/Space meant for the options button (phase-3 critic:
  // the old role="button" row selected the conversation instead, WCAG 2.1.1).
  const handleRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && (isMenuOpen || isDeleteConfirmOpen)) {
      // Consumed here: Escape closes this menu only, not an enclosing drawer.
      e.stopPropagation();
      kebabRef.current?.focus();
      setIsMenuOpen(false);
      setIsDeleteConfirmOpen(false);
    }
  };

  const displayTitle = title || 'Untitled conversation';
  const time = <span className="app-conv__time">{formatRelativeTime(timestamp)}</span>;

  // Structure: the row is a plain container holding two SIBLING buttons (select,
  // options), not a role="button" with a button nested inside it.
  // Focus leaving the menu (and its options button) by keyboard, e.g. Tab past the
  // last item, closes it (review round 4, LOW-1). A null relatedTarget (a click on
  // something unfocusable) is left to the click-outside handler above.
  const handleRootBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!isMenuOpen && !isDeleteConfirmOpen) return;
    const to = e.relatedTarget as Node | null;
    if (!to) return;
    if (menuRef.current?.contains(to) || kebabRef.current?.contains(to)) return;
    setIsMenuOpen(false);
    setIsDeleteConfirmOpen(false);
  };

  return (
    <div
      onKeyDown={handleRootKeyDown}
      onBlur={handleRootBlur}
      className={cx('app-conv', isSelected && 'ui-selected')}
    >
      {isRenaming ? (
        <div className="app-conv__edit">
          <input
            ref={inputRef}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            aria-label="Edit conversation title"
            className="app-conv__input"
          />
          {time}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (!isMenuOpen && !isDeleteConfirmOpen) onSelect(id);
          }}
          // 'true', not 'page' (phase-3 review F4): the current PAGE is the Chat nav
          // item; the selected conversation is the current item within this list.
          aria-current={isSelected ? 'true' : undefined}
          className="app-conv__select ui-focusable"
        >
          <span className="app-conv__title" title={displayTitle}>
            {displayTitle}
          </span>
          {time}
        </button>
      )}
      {!isRenaming && (
        <button
          ref={kebabRef}
          type="button"
          onClick={handleKebabClick}
          aria-label="Conversation options"
          aria-haspopup="menu"
          aria-expanded={isMenuOpen || isDeleteConfirmOpen}
          className="app-conv__kebab ui-focusable"
        >
          <Icon name="ellipsis" size={18} />
        </button>
      )}
      {(isMenuOpen || isDeleteConfirmOpen) && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Conversation actions"
          className="app-menu"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          {isDeleteConfirmOpen ? (
            <div className="app-menu__confirm" role="alert">
              <div className="app-menu__confirm-text">Delete this conversation?</div>
              <div className="app-menu__confirm-actions">
                <Button role="menuitem" size="sm" variant="danger" onClick={handleConfirmDelete}>
                  Confirm
                </Button>
                <Button role="menuitem" size="sm" variant="secondary" onClick={handleCancelDelete}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={handleRenameClick} className="app-menu__item ui-focusable">
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handleDeleteClick}
                className="app-menu__item app-menu__item--danger ui-focusable"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

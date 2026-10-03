/**
 * Lumen UI primitives (docs/design/design-language.md section 4). Importing this module
 * also loads the component stylesheet; the design tokens themselves come from
 * styles/theme.css -> lumen-tokens.css.
 *
 * Deferred (not shipped without real tests): Combobox (ARIA 1.2 model picker),
 * Toast (needs a provider that replaces ToastProvider).
 */
import './ui.css';

export { Icon, ICON_NAMES, type IconName, type IconProps } from './icons';
export { Button, IconButton, type ButtonProps, type IconButtonProps, type ButtonVariant, type ButtonSize } from './Button';
// NOTE: `ProgressBar` (Feedback) and `EmptyState` (Layout) are NOT interchangeable with
// components/SettingsMetrics (ProgressBar) and components/EmptyState. The phase-4 Settings
// migration retires the SettingsMetrics ProgressBar; components/EmptyState (no non-test
// consumers today) is removed when the first surface adopts the ui/ EmptyState. Do not
// alias or swap them before then.
export {
  Card,
  Section,
  PageHeader,
  EmptyState,
  KeyValueList,
  type SectionProps,
  type PageHeaderProps,
  type EmptyStateProps,
  type KeyValueItem,
} from './Layout';
export {
  Field,
  TextInput,
  PasswordInput,
  Select,
  Switch,
  Checkbox,
  SegmentedControl,
  RadioCardGroup,
  type FieldProps,
  type FieldControlProps,
  type TextInputProps,
  type ChoiceOption,
} from './Forms';
export {
  Badge,
  StatusPill,
  Banner,
  Skeleton,
  ProgressBar,
  Kbd,
  type Tone,
  type BadgeProps,
  type BannerProps,
  type ProgressBarProps,
} from './Feedback';
export { Dialog, Tooltip, type DialogProps, type TooltipProps } from './Overlays';
export { Tabs, type TabItem, type TabsProps } from './Tabs';
export {
  AppShell,
  SideNav,
  ProductMark,
  useAppShell,
  DRAWER_MEDIA_QUERY,
  type AppShellProps,
  type SideNavItem,
  type SideNavProps,
  type DrawerCloseReason,
} from './AppShell';

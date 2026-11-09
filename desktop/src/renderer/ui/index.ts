// Bibliothèque de composants de Cairn : seul endroit où vivent les éléments HTML natifs et les styles de contrôle.
// Les composants reçoivent tous leurs textes en props (traduits par l'appelant avec t()).

export { Badge } from "./Badge.tsx";
export type { Tone } from "./Banner.tsx";
export { Banner, type BannerProps } from "./Banner.tsx";
export { BreakdownBar, type BreakdownBarProps, type BreakdownPart } from "./BreakdownBar.tsx";
export { BreakdownChart, type BreakdownChartProps, type BreakdownItem } from "./BreakdownChart.tsx";
export { Button, type ButtonProps, type ButtonVariant } from "./Button.tsx";
export { CairnLogo, type CairnLogoProps } from "./CairnLogo.tsx";
export { Card, type CardProps } from "./Card.tsx";
export { CardTray } from "./CardTray.tsx";
export { CategoryTag } from "./CategoryTag.tsx";
export { Checkbox, type CheckboxProps } from "./Checkbox.tsx";
export { ChoiceChip, type ChoiceChipProps } from "./ChoiceChip.tsx";
export { ChoiceTile, type ChoiceTileProps } from "./ChoiceTile.tsx";
export { CATEGORIES, CATEGORY_KEYS, type CategoryKey } from "./categories.ts";
export { DropdownMenu, type DropdownMenuProps, type DropdownOption } from "./DropdownMenu.tsx";
export { FillBar, type FillBarProps } from "./FillBar.tsx";
export { FilterChip, type FilterChipProps } from "./FilterChip.tsx";
export { type Crumb, FolderBreadcrumb, type FolderBreadcrumbProps } from "./FolderBreadcrumb.tsx";
export { FolderRow, type FolderRowProps } from "./FolderRow.tsx";
export type { Align, Side } from "./floating.ts";
export { ICON_STROKE, Icon, type IconProps, type LucideIcon } from "./Icon.tsx";
export { IconButton, type IconButtonProps } from "./IconButton.tsx";
export { IconTile, type IconTileProps } from "./IconTile.tsx";
export { MessageBar, type MessageBarProps } from "./MessageBar.tsx";
export { MiddleText } from "./MiddleText.tsx";
export { MoreButton, type MoreButtonProps } from "./MoreButton.tsx";
export { NumberStepper, type NumberStepperProps } from "./NumberStepper.tsx";
export { PasswordField, type PasswordFieldProps } from "./PasswordField.tsx";
export { PathField, type PathFieldProps, type PathSuggestion } from "./PathField.tsx";
export { type PickerOption, PillPicker, type PillPickerProps } from "./PillPicker.tsx";
export {
  MenuButton,
  type MenuButtonProps,
  type MenuEntry,
  type MenuItem,
  type MenuSeparator,
  normalizeEntries,
  PopupMenu,
  type PopupMenuProps,
  useContextMenu,
} from "./PopupMenu.tsx";
export { ProgressBar, type ProgressBarProps } from "./ProgressBar.tsx";
export { ProjectBar, type ProjectBarProps } from "./ProjectBar.tsx";
export { RailButton, type RailButtonProps } from "./RailButton.tsx";
export { RowDivider } from "./RowDivider.tsx";
export { SectionTitle } from "./SectionTitle.tsx";
export { type Segment, SegmentBar } from "./SegmentBar.tsx";
export { SelectableRow, type SelectableRowProps } from "./SelectableRow.tsx";
export { SettingsRow, type SettingsRowProps } from "./SettingsRow.tsx";
export { Sheet, type SheetProps } from "./Sheet.tsx";
export { SidebarHeader } from "./SidebarHeader.tsx";
export { ProgressRing, SidebarRow, type SidebarRowProps } from "./SidebarRow.tsx";
export { Spinner, type SpinnerProps, type SpinnerSize } from "./Spinner.tsx";
export { Stat, type StatProps } from "./Stat.tsx";
export { TabBar, type TabBarProps } from "./TabBar.tsx";
export { Table, type TableColumn, type TableProps, type TableSort } from "./Table.tsx";
export { TextField, type TextFieldProps } from "./TextField.tsx";
export { Toggle, type ToggleProps, ToggleTrack } from "./Toggle.tsx";
export { Tooltip, type TooltipProps } from "./Tooltip.tsx";
export { WizardStepper, type WizardStepperProps } from "./WizardStepper.tsx";
export { WorkerRow, type WorkerRowProps } from "./WorkerRow.tsx";

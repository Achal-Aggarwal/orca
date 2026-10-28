import React, { useCallback, useMemo, useState } from 'react'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import {
  getProjectHostSetupSelectionKey,
  type NeedsSetupProjectHostOption,
  type ProjectHostSetupOption,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { isWithinComboboxRoot, useTypeAheadCombobox } from './use-type-ahead-combobox'
import {
  buildRunTargetRows,
  isSelectableRunTargetRow,
  readyHostRowKey,
  RUN_TARGET_ADD_HOST_KEY,
  type EphemeralVmRecipeOption
} from './run-target-options'
import { useRunTargetMachines, type RunTargetMachineProps } from './use-run-target-machines'
import type { MachineRowModel } from './run-target-machine-rows'
import { useNow } from '@/hooks/use-now'
import { AddHostSubmenuRow } from './RunTargetSubmenus'
import RunTargetRowList from './RunTargetRowList'
import RunTargetField, { describeCommittedTarget } from './RunTargetField'
import { HostListOverflowNote } from '@/components/host-picker/HostListOverflowNote'

type RunTargetComboboxProps = {
  hostOptions: readonly ProjectHostSetupOption[]
  hostValue: string | null
  hostExecutionHostId?: ExecutionHostId | null
  onHostChange?: (setupId: string) => void
  recipes: EphemeralVmRecipeOption[]
  recipeValue: string | null
  onRecipeChange?: (recipeId: string | null) => void
  onAddRemoteServer?: () => void
  onAddSshHost?: () => void
  onConnectHost?: (option: NeedsSetupProjectHostOption) => Promise<void> | void
  onSetLocation?: (option: NeedsSetupProjectHostOption) => void
  /** Provider groups; absent while machines are off. */
  machines?: RunTargetMachineProps
  onBrowseMachinePlugins?: () => void
}

const ROOT_ATTRIBUTE = 'data-run-target-combobox-root'

/** Match project-picker navigation; Connect must not select its host, and recipe/Add host rows open nested lists. */
export default function RunTargetCombobox({
  hostOptions,
  hostValue,
  hostExecutionHostId,
  onHostChange,
  recipes,
  recipeValue,
  onRecipeChange,
  onAddRemoteServer,
  onAddSshHost,
  onConnectHost,
  onSetLocation,
  machines,
  onBrowseMachinePlugins
}: RunTargetComboboxProps): React.JSX.Element {
  const [submenu, setSubmenu] = useState<'recipes' | 'add-host' | null>(null)
  // Track in-flight connects per host so one stalling connect never blocks the others.
  const [connectingHostIds, setConnectingHostIds] = useState<ReadonlySet<string>>(() => new Set())

  const hasAddHost = Boolean(onAddSshHost || onAddRemoteServer || onBrowseMachinePlugins)
  const machineRows = useRunTargetMachines(machines)
  const {
    groups: machineGroups,
    views: machineViews,
    selectedRowKey: selectedMachineRowKey,
    activate: activateMachine
  } = machineRows
  const selectedMachine = machines?.selected ?? null
  const deriveRowKeys = useCallback(
    (query: string): string[] =>
      buildRunTargetRows({ hostOptions, recipes, machineGroups, machineViews, query, hasAddHost })
        .rows.filter(isSelectableRunTargetRow)
        .map((row) => row.key),
    [hasAddHost, hostOptions, machineGroups, machineViews, recipes]
  )
  const readyHostOptions = useMemo(
    () => hostOptions.filter((option) => option.kind === 'ready'),
    [hostOptions]
  )
  const isSelected = (candidate: { id: string; hostId: string }): boolean =>
    candidate.id === hostValue && (!hostExecutionHostId || candidate.hostId === hostExecutionHostId)
  const selectedHost =
    readyHostOptions.find(isSelected) ??
    // Why: a selection on a merged machine's other id still belongs to that machine's one row.
    readyHostOptions.find((option) => option.aliasSetups?.some(isSelected)) ??
    readyHostOptions[0] ??
    null
  const selectedRecipe = recipes.find((recipe) => recipe.id === recipeValue) ?? null
  // Why: opening arms the current row, so the one filled row is the selection.
  const currentRowKey =
    selectedMachineRowKey ??
    (selectedRecipe === null && selectedHost !== null ? readyHostRowKey(selectedHost) : null)
  const combobox = useTypeAheadCombobox(deriveRowKeys, currentRowKey)
  const {
    query,
    setQuery,
    open,
    setOpen,
    close: closeCombobox,
    armedKey,
    arm,
    moveArm,
    inputRef,
    listId,
    setListNode
  } = combobox
  const now = useNow(60_000, open)

  const { rows, matchedRecipes, hiddenHostCount } = useMemo(
    () =>
      buildRunTargetRows({ hostOptions, recipes, machineGroups, machineViews, query, hasAddHost }),
    [hasAddHost, hostOptions, machineGroups, machineViews, query, recipes]
  )
  const armedRow =
    rows.find((row) => row.key === armedKey) ?? rows.find(isSelectableRunTargetRow) ?? null
  // Only a committed selection paints the field; typing replaces it.
  const creatingMachine = machines?.creating ?? null
  const committed =
    query.length === 0 &&
    (creatingMachine !== null ||
      selectedMachine !== null ||
      selectedRecipe !== null ||
      selectedHost !== null)

  // Closing also drops any open submenu, which the shared hook doesn't know about.
  const close = useCallback((): void => {
    closeCombobox()
    setSubmenu(null)
  }, [closeCombobox])

  const selectHost = useCallback(
    (option: ReadyProjectHostSetupOption): void => {
      onHostChange?.(getProjectHostSetupSelectionKey(option))
      onRecipeChange?.(null)
      machines?.onChange(null)
      close()
    },
    [close, machines, onHostChange, onRecipeChange]
  )

  const selectRecipe = useCallback(
    (recipeId: string): void => {
      onRecipeChange?.(recipeId)
      machines?.onChange(null)
      close()
    },
    [close, machines, onRecipeChange]
  )

  const connectHost = useCallback(
    async (option: NeedsSetupProjectHostOption): Promise<void> => {
      if (!option.connectAction || !onConnectHost || connectingHostIds.has(option.hostId)) {
        return
      }
      setConnectingHostIds((current) => new Set(current).add(option.hostId))
      try {
        await onConnectHost(option)
      } finally {
        setConnectingHostIds((current) => {
          if (!current.has(option.hostId)) {
            return current
          }
          const next = new Set(current)
          next.delete(option.hostId)
          return next
        })
      }
    },
    [connectingHostIds, onConnectHost]
  )

  // Row clicks, inline actions and Enter must all close the picker before opening the setup dialog.
  const setLocation = useCallback(
    (option: NeedsSetupProjectHostOption): void => {
      if (!option.canSetLocation || !onSetLocation) {
        return
      }
      close()
      onSetLocation(option)
    },
    [close, onSetLocation]
  )

  const activateMachineRow = useCallback(
    (row: MachineRowModel): void => {
      if (row.kind === 'machine' || row.kind === 'machine-create') {
        onRecipeChange?.(null)
      }
      // Why: a paired server's machine runs worktrees at the project's location on it.
      if (row.kind === 'machine' && row.machine.locationKey) {
        onHostChange?.(row.machine.locationKey)
      }
      activateMachine(row, close)
    },
    [activateMachine, close, onHostChange, onRecipeChange]
  )

  /** Commits a row, or opens its submenu when the row is a submenu row. */
  const activate = useCallback(
    (key: string | null): void => {
      const row = rows.find((candidate) => candidate.key === key)
      if (!row || !isSelectableRunTargetRow(row)) {
        return
      }
      if (row.kind === 'ready') {
        selectHost(row.option)
        return
      }
      if (row.kind === 'needs-setup') {
        setLocation(row.option)
        return
      }
      if (row.kind === 'recipes' || row.kind === 'add-host') {
        setSubmenu(row.kind)
        return
      }
      activateMachineRow(row)
    },
    [activateMachineRow, rows, selectHost, setLocation]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
        moveArm(event.key === 'ArrowDown' ? 1 : -1)
        setSubmenu(null)
        return
      }
      if ((event.key === 'Enter' || event.key === 'ArrowRight') && open) {
        event.preventDefault()
        activate(armedRow?.key ?? null)
        return
      }
      if (event.key === 'Escape' && (open || query.length > 0)) {
        event.preventDefault()
        event.stopPropagation()
        if (submenu !== null) {
          setSubmenu(null)
          return
        }
        close()
      }
    },
    [activate, armedRow, close, moveArm, open, query, setOpen, submenu]
  )

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        setOpen(true)
        return
      }
      close()
    },
    [close, setOpen]
  )

  const field = describeCommittedTarget({
    creatingMachine,
    selectedMachine,
    selectedRecipe,
    selectedHost
  })

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <RunTargetField
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setOpen(true)
          setSubmenu(null)
        }}
        open={open}
        onOpenRequest={() => setOpen(true)}
        onToggle={() => setOpen(!open)}
        committed={committed}
        kind={field.kind}
        status={field.status}
        hostId={selectedHost?.hostId ?? null}
        label={field.label}
        detail={field.detail}
        listId={listId}
        hasArmedRow={armedRow !== null}
        inputRef={inputRef}
        onKeyDown={handleKeyDown}
      />
      <PopoverContent
        align="start"
        sideOffset={4}
        surface="opaque"
        className="flex w-[var(--radix-popover-trigger-width)] min-w-[18rem] flex-col"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The search anchor is outside Radix content; preserve interactions inside this control.
        onFocusOutside={(event) => {
          if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
            event.preventDefault()
          }
        }}
        onInteractOutside={(event) => {
          if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
            event.preventDefault()
          }
        }}
      >
        <div
          id={listId}
          role="listbox"
          aria-label={translate(
            'auto.components.new.workspace.RunTargetCombobox.listLabel',
            'Run targets'
          )}
          className="flex min-h-0 flex-col"
        >
          <div
            ref={setListNode}
            role="presentation"
            className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-sleek"
          >
            {rows.filter((row) => row.kind !== 'add-host').length === 0 ? (
              <p className="flex h-8 items-center justify-center px-2 text-sm text-muted-foreground">
                {translate(
                  'auto.components.NewWorkspaceComposerCard.noRunTargets',
                  'No run targets are ready for this project.'
                )}
              </p>
            ) : null}
            <RunTargetRowList
              rows={rows}
              armedKey={armedRow?.key ?? null}
              listId={listId}
              selectedHost={
                selectedRecipe === null && selectedMachine === null ? selectedHost : null
              }
              selectedRecipeId={selectedRecipe?.id ?? null}
              matchedRecipes={matchedRecipes}
              recipesOpen={submenu === 'recipes'}
              connectingHostIds={connectingHostIds}
              canConnect={Boolean(onConnectHost)}
              canSetLocation={Boolean(onSetLocation)}
              onArm={(key, nextSubmenu) => {
                arm(key)
                setSubmenu(nextSubmenu)
              }}
              onRecipesOpenChange={(next) => setSubmenu(next ? 'recipes' : null)}
              onSelectHost={selectHost}
              onSelectRecipe={selectRecipe}
              onConnectHost={(option) => void connectHost(option)}
              onSetLocation={setLocation}
              selectedMachineRowKey={selectedMachineRowKey}
              now={now}
              onActivateMachineRow={activateMachineRow}
            />
          </div>
          <HostListOverflowNote hiddenCount={hiddenHostCount} />
          {hasAddHost ? (
            <AddHostSubmenuRow
              open={submenu === 'add-host'}
              onOpenChange={(next) => setSubmenu(next ? 'add-host' : null)}
              armed={armedRow?.key === RUN_TARGET_ADD_HOST_KEY}
              optionId={armedRow?.key === RUN_TARGET_ADD_HOST_KEY ? `${listId}-armed` : undefined}
              onArm={() => {
                arm(RUN_TARGET_ADD_HOST_KEY)
                setSubmenu('add-host')
              }}
              {...(onAddSshHost
                ? {
                    onAddSshHost: () => {
                      close()
                      onAddSshHost()
                    }
                  }
                : {})}
              {...(onAddRemoteServer
                ? {
                    onAddRemoteServer: () => {
                      close()
                      onAddRemoteServer()
                    }
                  }
                : {})}
              {...(onBrowseMachinePlugins
                ? {
                    onBrowseMachinePlugins: () => {
                      close()
                      onBrowseMachinePlugins()
                    }
                  }
                : {})}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

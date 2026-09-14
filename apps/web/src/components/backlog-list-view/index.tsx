import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";
import { useNavigate } from "@tanstack/react-router";
import { produce } from "immer";
import { Archive, Clock, Flag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { priorityColorsTaskCard } from "@/constants/priority-colors";
import { useUpdateTask } from "@/hooks/mutations/task/use-update-task";
import useGetCustomFieldValuesByProject, {
  type CustomFieldValue,
} from "@/hooks/queries/custom-field/use-get-custom-field-values-by-project";
import { useRegisterShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { cn } from "@/lib/cn";
import useBacklogBulkSelectionStore from "@/store/backlog-bulk-selection";
import useProjectStore from "@/store/project";
import type { ProjectWithTasks } from "@/types/project";
import BacklogBulkToolbar from "../bulk-selection/backlog-bulk-toolbar";
import CreateTaskModal from "../shared/modals/create-task-modal";
import BacklogSection, { type BacklogSectionId } from "./backlog-section";

const dragModifiers = [snapCenterToCursor];

type BacklogListViewProps = {
  project?: ProjectWithTasks;
  disableDragDrop?: boolean;
};

function BacklogListView({
  project,
  disableDragDrop = false,
}: BacklogListViewProps) {
  const { t } = useTranslation();
  const { mutate: updateTask } = useUpdateTask();
  const setProject = useProjectStore((state) => state.setProject);
  const {
    setAvailableTasks,
    focusNext,
    focusPrevious,
    focusedTaskId,
    clearFocus,
  } = useBacklogBulkSelectionStore(
    useShallow((state) => ({
      setAvailableTasks: state.setAvailableTasks,
      focusNext: state.focusNext,
      focusPrevious: state.focusPrevious,
      focusedTaskId: state.focusedTaskId,
      clearFocus: state.clearFocus,
    })),
  );
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overColumnId, setOverColumnId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<
    Record<BacklogSectionId, boolean>
  >({
    planned: true,
    archived: true,
  });
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [activeColumn, setActiveColumn] = useState<string | null>(null);

  // Fetched once here instead of once per row: with N tasks and M values the
  // per-row variant filtered the full list N times on every render.
  const { data: projectCustomFieldValues } = useGetCustomFieldValuesByProject(
    project?.id ?? "",
  );
  const customFieldValuesByTask = useMemo(() => {
    const byTask = new Map<string, CustomFieldValue[]>();
    for (const value of projectCustomFieldValues ?? []) {
      const existing = byTask.get(value.taskId);
      if (existing) {
        existing.push(value);
      } else {
        byTask.set(value.taskId, [value]);
      }
    }
    return byTask;
  }, [projectCustomFieldValues]);

  useEffect(() => {
    if (project) {
      const visibleTaskIds: string[] = [];
      if (expandedSections.planned) {
        visibleTaskIds.push(
          ...(project.plannedTasks || []).map((task) => task.id),
        );
      }
      if (expandedSections.archived) {
        visibleTaskIds.push(
          ...(project.archivedTasks || []).map((task) => task.id),
        );
      }
      setAvailableTasks(visibleTaskIds);
    }
  }, [project, expandedSections, setAvailableTasks]);

  useEffect(() => {
    clearFocus();
  }, [clearFocus]);

  useRegisterShortcuts({
    shortcuts: {
      j: () => {
        focusNext();
        const state = useBacklogBulkSelectionStore.getState();
        if (state.focusedTaskId) {
          navigate({ to: ".", search: { taskId: state.focusedTaskId } });
        }
      },
      k: () => {
        focusPrevious();
        const state = useBacklogBulkSelectionStore.getState();
        if (state.focusedTaskId) {
          navigate({ to: ".", search: { taskId: state.focusedTaskId } });
        }
      },
      Enter: () => {
        if (focusedTaskId && project) {
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
            params: {
              workspaceId: project.workspaceId,
              projectId: project.id,
              taskId: focusedTaskId,
            },
          });
        }
      },
    },
  });

  // useSensor memoizes on the options object; fresh literals every render meant
  // new sensors -> new DndContext value -> every useSortable row re-rendered on
  // each parent render (e.g. the 30s tasks refetch).
  const mouseSensorOptions = useMemo(
    () => ({
      activationConstraint: { distance: disableDragDrop ? 999999 : 8 },
    }),
    [disableDragDrop],
  );
  const touchSensorOptions = useMemo(
    () => ({
      activationConstraint: {
        delay: disableDragDrop ? 999999 : 200,
        tolerance: 8,
      },
    }),
    [disableDragDrop],
  );
  const sensors = useSensors(
    useSensor(MouseSensor, mouseSensorOptions),
    useSensor(TouchSensor, touchSensorOptions),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (!over || !activeId) {
      setOverColumnId(null);
      return;
    }

    if (over.id === "planned" || over.id === "archived") {
      setOverColumnId(over.id.toString());
      return;
    }

    const taskId = over.id.toString();
    const plannedTasks = project?.plannedTasks || [];
    const archivedTasks = project?.archivedTasks || [];

    if (plannedTasks.some((task) => task.id === taskId)) {
      setOverColumnId("planned");
    } else if (archivedTasks.some((task) => task.id === taskId)) {
      setOverColumnId("archived");
    } else {
      setOverColumnId(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    setOverColumnId(null);

    if (!over || !project) return;

    const activeTaskId = active.id.toString();
    const overId = over.id.toString();

    const plannedTasks = project.plannedTasks || [];
    const archivedTasks = project.archivedTasks || [];
    const activeTask = [...plannedTasks, ...archivedTasks].find(
      (task) => task.id === activeTaskId,
    );

    if (!activeTask) return;

    let targetSection = overId;
    if (overId !== "planned" && overId !== "archived") {
      if (plannedTasks.some((task) => task.id === overId)) {
        targetSection = "planned";
      } else if (archivedTasks.some((task) => task.id === overId)) {
        targetSection = "archived";
      } else {
        return;
      }
    }

    const updatedProject = produce(project, (draft) => {
      const sourceSection =
        activeTask.status === "planned"
          ? draft.plannedTasks || []
          : draft.archivedTasks || [];

      const sourceTaskIndex = sourceSection.findIndex(
        (task) => task.id === activeTaskId,
      );
      const task = sourceSection[sourceTaskIndex];

      if (!task) return;

      if (activeTask.status === "planned") {
        draft.plannedTasks =
          draft.plannedTasks?.filter((t) => t.id !== activeTaskId) || [];
      } else {
        draft.archivedTasks =
          draft.archivedTasks?.filter((t) => t.id !== activeTaskId) || [];
      }

      if (activeTask.status === targetSection) {
        const targetSectionTasks =
          activeTask.status === "planned"
            ? draft.plannedTasks || []
            : draft.archivedTasks || [];

        let destinationIndex = targetSectionTasks.findIndex(
          (t) => t.id === overId,
        );

        if (sourceTaskIndex <= destinationIndex) {
          destinationIndex += 1;
        }

        if (activeTask.status === "planned") {
          draft.plannedTasks?.splice(destinationIndex, 0, task);
        } else {
          draft.archivedTasks?.splice(destinationIndex, 0, task);
        }

        const finalTasks =
          activeTask.status === "planned"
            ? draft.plannedTasks || []
            : draft.archivedTasks || [];

        finalTasks.forEach((t, index) => {
          updateTask({
            ...t,
            position: index,
          });
        });
      } else {
        task.status = targetSection;

        if (targetSection === "planned") {
          draft.plannedTasks = [...(draft.plannedTasks || []), task];
        } else {
          draft.archivedTasks = [...(draft.archivedTasks || []), task];
        }

        const updatedTasks =
          targetSection === "planned"
            ? draft.plannedTasks || []
            : draft.archivedTasks || [];

        updatedTasks.forEach((t, index) => {
          updateTask({
            ...t,
            status: targetSection,
            position: index,
          });
        });

        const sourceTasks =
          activeTask.status === "planned"
            ? draft.plannedTasks || []
            : draft.archivedTasks || [];

        sourceTasks.forEach((t, index) => {
          updateTask({
            ...t,
            position: index,
          });
        });
      }
    });

    setProject(updatedProject);
  };

  const toggleSection = useCallback((sectionId: BacklogSectionId) => {
    setExpandedSections((prev) => ({
      ...prev,
      [sectionId]: !prev[sectionId],
    }));
  }, []);

  const handleAddPlannedTask = useCallback(() => {
    setIsTaskModalOpen(true);
    setActiveColumn("planned");
  }, []);

  if (!project) {
    return null;
  }

  const plannedTasks = project.plannedTasks || [];
  const archivedTasks = project.archivedTasks || [];

  const activeTask =
    project.plannedTasks.find((task) => task.id === activeId) ||
    project.archivedTasks.find((task) => task.id === activeId);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      modifiers={dragModifiers}
    >
      <div className="w-full h-full overflow-auto bg-muted/20">
        <div className="divide-y divide-border/50">
          <BacklogSection
            sectionId="planned"
            title={t("tasks:backlog.sections.planned")}
            icon={Clock}
            tasks={plannedTasks}
            expanded={expandedSections.planned}
            showDropIndicator={!!activeId && overColumnId === "planned"}
            showAddButton={true}
            onToggle={toggleSection}
            onAddTask={handleAddPlannedTask}
            customFieldValuesByTask={customFieldValuesByTask}
          />

          <BacklogSection
            sectionId="archived"
            title={t("tasks:backlog.sections.archived")}
            icon={Archive}
            tasks={archivedTasks}
            expanded={expandedSections.archived}
            showDropIndicator={!!activeId && overColumnId === "archived"}
            onToggle={toggleSection}
            customFieldValuesByTask={customFieldValuesByTask}
          />
        </div>
      </div>

      <DragOverlay>
        {activeTask && (
          <div className="bg-card border border-border rounded-lg shadow-lg p-2 max-w-[200px] cursor-grabbing">
            <div className="flex items-center gap-2">
              <div className="flex-shrink-0">
                <Flag
                  className={cn(
                    "w-3 h-3",
                    priorityColorsTaskCard[
                      activeTask.priority as keyof typeof priorityColorsTaskCard
                    ],
                  )}
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {project?.slug}-{activeTask.number}
                  </span>
                  <span className="text-xs text-foreground truncate">
                    {activeTask.title}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </DragOverlay>

      <CreateTaskModal
        open={isTaskModalOpen}
        projectId={project?.id}
        onClose={() => setIsTaskModalOpen(false)}
        status={activeColumn ?? "planned"}
      />

      <BacklogBulkToolbar />
    </DndContext>
  );
}

export default BacklogListView;

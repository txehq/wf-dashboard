import { useMutation } from '@tanstack/react-query';
import { Target } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { type LiveDetail, setLiveGoal } from '@/lib/live-api';

// The goal handed to the simulated user (Contracts 34.2): only what it should do this time, no user persona

export function GoalField({
  id,
  value,
  onChange,
  // The dialog heading already says this, so the label is for screen readers only
  hideLabel = false,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  hideLabel?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        Goal for the simulated user
      </Label>
      <Textarea
        id={id}
        data-testid="goal-input"
        rows={3}
        value={value}
        placeholder="The simulated user steers the agent by this and hands back to you when it's done"
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

// Dialog shown the first time control goes to the simulated user (prefilled with the item's first
// request), shared with viewing and editing from the toolbar
export function GoalDialog({
  heading,
  initial,
  pending,
  error,
  onSave,
  onClose,
}: {
  heading: string;
  initial: string;
  pending: boolean;
  error: string | null;
  onSave: (goal: string) => void;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState(initial);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        className="flex w-[36rem] max-w-[95vw] flex-col gap-4 rounded-lg border bg-background p-5 shadow-lg"
        data-testid="goal-dialog"
      >
        <h2 className="text-base font-semibold">{heading}</h2>
        <GoalField id="live-goal" value={goal} onChange={setGoal} hideLabel />
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="goal-save"
            disabled={goal.trim() === '' || pending}
            onClick={() => {
              onSave(goal.trim());
            }}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// The goal in the toolbar: items without a task show this button, which opens it for viewing and editing (Contracts 34.2)
export function GoalButton({ live }: { live: LiveDetail }) {
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: (goal: string) => setLiveGoal(live.id, goal),
    onSuccess: () => {
      setOpen(false);
    },
  });
  const goal = live.simulatedGoal;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        data-testid="goal-open"
        title={goal ?? 'No goal for the simulated user yet'}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Target />
        <span data-toolbar-label>Goal</span>
      </Button>
      {open && (
        <GoalDialog
          heading="Goal for the simulated user"
          initial={goal ?? live.simulatedGoalDefault}
          pending={save.isPending}
          error={save.isError ? save.error.message : null}
          onSave={(next) => {
            save.mutate(next);
          }}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

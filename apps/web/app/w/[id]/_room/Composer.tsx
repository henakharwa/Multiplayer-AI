import type { ComponentProps, FormEvent, Ref } from "react";
import { MAX_CHAT_MESSAGE_CHARS } from "../../../../lib/config";
import AgentSelector from "./AgentSelector";
import StarterPrompts from "./StarterPrompts";
import { ArrowGlyph } from "./glyphs";

type AgentSelectorProps = Omit<ComponentProps<typeof AgentSelector>, "compact">;
type StarterPromptProps = Omit<ComponentProps<typeof StarterPrompts>, "compact">;

export type ComposerProps = {
  draft: string;
  onDraftChange: (value: string) => void;
  inputRef: Ref<HTMLInputElement>;
  onSubmit: (event: FormEvent) => void;
  inputDisabled: boolean;
  sendDisabled: boolean;
  agentSelector: AgentSelectorProps;
  starterPrompts: StarterPromptProps;
};

type OnboardingStep = { label: string; complete: boolean; action?: () => void };

// What a new, empty conversation shows: a large composer, starter prompts
// and the getting-started checklist.
export function EmptyConversation({
  greetingName,
  onboardingSteps,
  ...composer
}: ComposerProps & { greetingName: string; onboardingSteps: OnboardingStep[] }) {
  return (
    <section className="workspace-empty-state">
      <p className="workspace-empty-eyebrow">Your shared AI workspace</p>
      <h2>What&apos;s next, {greetingName}?</h2>
      <p className="workspace-empty-copy">
        Choose an agent, ask a question, and approve actions only when your team is ready.
      </p>
      <form className="workspace-hero-composer" onSubmit={composer.onSubmit}>
        <input
          ref={composer.inputRef}
          maxLength={MAX_CHAT_MESSAGE_CHARS}
          data-testid="chat-input"
          placeholder="Get work done"
          value={composer.draft}
          onChange={(event) => composer.onDraftChange(event.target.value)}
          disabled={composer.inputDisabled}
          autoComplete="off"
        />
        <div className="workspace-hero-composer-footer">
          <AgentSelector {...composer.agentSelector} />
          <button type="submit" data-testid="send-btn" disabled={composer.sendDisabled} aria-label="Start chat">
            <ArrowGlyph />
          </button>
        </div>
      </form>
      <StarterPrompts {...composer.starterPrompts} />
      <section className="workspace-onboarding" aria-label="Getting started">
        <div>
          <p>Getting started</p>
          <span>
            {onboardingSteps.filter((step) => step.complete).length} of {onboardingSteps.length} complete
          </span>
        </div>
        <ol>
          {onboardingSteps.map((step) => (
            <li key={step.label} className={step.complete ? "complete" : ""}>
              {step.complete ? <span aria-label="Complete">✓</span> : <span aria-hidden>○</span>}
              {step.action && !step.complete ? (
                <button type="button" onClick={step.action}>
                  {step.label}
                </button>
              ) : (
                <em>{step.label}</em>
              )}
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}

// The composer under an ongoing conversation.
export function ChatComposer({
  placeholder,
  workspaceName,
  ...composer
}: ComposerProps & { placeholder: string; workspaceName: string }) {
  return (
    <div className="workspace-composer-wrap">
      <StarterPrompts compact {...composer.starterPrompts} />
      <form className="composer" onSubmit={composer.onSubmit}>
        <input
          ref={composer.inputRef}
          maxLength={MAX_CHAT_MESSAGE_CHARS}
          data-testid="chat-input"
          placeholder={placeholder}
          value={composer.draft}
          onChange={(event) => composer.onDraftChange(event.target.value)}
          disabled={composer.inputDisabled}
          autoComplete="off"
        />
        <AgentSelector {...composer.agentSelector} compact />
        <button className="composer-send" type="submit" data-testid="send-btn" disabled={composer.sendDisabled}>
          <ArrowGlyph />
        </button>
      </form>
      <p className="workspace-composer-note">
        Messages are shared with everyone in {workspaceName}. Use @agent or @mention a teammate to direct the next step.
      </p>
    </div>
  );
}

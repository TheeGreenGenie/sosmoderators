import { Devvit } from '@devvit/public-api';
import type { Context } from '@devvit/public-api';
import { setPreset, type PresetName } from '../../redis/config.js';
import { logAction } from '../../moderation/auditLog.js';

const PRESETS: { name: PresetName; label: string; description: string }[] = [
  { name: 'default', label: 'Default', description: 'Balanced. Good for established subs.' },
  { name: 'strict', label: 'Strict', description: '90+ day accounts required to post.' },
  { name: 'raid', label: 'Raid Mode', description: '180+ days + 1000 karma. For active raids.' },
];

export function createOnboardingWizard(context: Context): Devvit.CustomPostComponent {
  return function OnboardingWizard(): JSX.Element {
    return (
      <vstack height="100%" width="100%" gap="small" padding="medium">
        <text size="large" weight="bold">Welcome to SubGuardian</text>
        <text size="small" color="neutral-content-weak">Choose a starting preset:</text>

        {PRESETS.map((preset) => (
          <hstack
            key={preset.name}
            backgroundColor="neutral-background"
            padding="small"
            cornerRadius="medium"
            alignment="start middle"
            gap="small"
          >
            <vstack grow gap="small">
              <text weight="bold" size="small">{preset.label}</text>
              <text size="small" color="neutral-content-weak">{preset.description}</text>
            </vstack>
            <button
              size="small"
              appearance="primary"
              onPress={async () => {
                await setPreset(context.redis, preset.name);
                await logAction(context.redis, {
                  timestamp: Date.now(),
                  action: 'onboarding_preset_selected',
                  targetId: preset.name,
                  targetType: 'config',
                  actor: 'mod',
                  reason: `Initial preset selected: ${preset.name}`,
                });
                context.ui.showToast(`${preset.label} preset activated!`);
              }}
            >
              Select
            </button>
          </hstack>
        ))}
      </vstack>
    );
  };
}

type Props = {
  tier: string;
  to: string;
  roles: readonly string[];
  onPick: (role: string) => void;
  onCancel: () => void;
};

// A link drawn from a tier to an intent needs a role before it exists: the
// target kind's roles, one click, and the whole link is one patch.
export function RolePicker({ tier, to, roles, onPick, onCancel }: Props) {
  return (
    <section className="panel role-picker">
      <header>
        <h2>
          Link {tier} to {to}
        </h2>
      </header>
      <p>Pick the role {tier} has on {to}:</p>
      <div className="choice">
        {roles.map((role) => (
          <button key={role} type="button" onClick={() => onPick(role)}>
            {role}
          </button>
        ))}
        <button type="button" className="quiet" onClick={onCancel}>
          cancel
        </button>
      </div>
    </section>
  );
}

# Pulumi Automation API as the deploy engine

Deploys run through Pulumi's Automation API, embedded in the CLI and studio, with state stored by default in an S3 bucket in the user's own account and Pulumi Cloud as an opt-in. The compiled Pulumi program is also the eject path: `hull eject` leaves a plain Pulumi project with the same state.

## Considered Options

- Terraform / OpenTofu: CLI-driven, so progress and diffs come from parsing text; awkward to drive from a studio.
- AWS CDK on CloudFormation: AWS-only, which conflicts with the GCP requirement; slow deploys and rollbacks.
- Custom engine on the AWS SDK: years of work on state, diffing, and drift.

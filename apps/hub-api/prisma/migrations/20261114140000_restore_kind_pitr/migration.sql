-- AlterEnum: point-in-time replay restores (a new value must be added in its own transaction before use)
ALTER TYPE "RestoreKind" ADD VALUE 'PITR';

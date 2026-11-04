-- Transitional status claimed while a database provisions, so a concurrent server-move is excluded.
ALTER TYPE "DbStatus" ADD VALUE 'PROVISIONING' AFTER 'NEW';

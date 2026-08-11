import type { Pool } from 'pg';

/**
 * Install a transaction-coupled write ledger in the disposable certification
 * database. PostgreSQL tuple statistics are eventually published by each
 * writer backend, so counters alone cannot prove that a net-zero insert/delete
 * near the end of the window was observed. These triggers append in the same
 * transaction as every committed row mutation; rollbacks leave no event and no
 * non-transactional sequence advance.
 */
export async function installPostgresWriteAudit(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE SCHEMA idle_purity_certification;
      CREATE TABLE idle_purity_certification.write_events (
        schema_name text NOT NULL,
        relation_name text NOT NULL,
        operation text NOT NULL,
        transaction_id bigint NOT NULL,
        recorded_at timestamptz NOT NULL
      );
      CREATE FUNCTION idle_purity_certification.record_row_write()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
      BEGIN
        INSERT INTO idle_purity_certification.write_events (
          schema_name,
          relation_name,
          operation,
          transaction_id,
          recorded_at
        ) VALUES (
          TG_TABLE_SCHEMA,
          TG_TABLE_NAME,
          TG_OP,
          txid_current(),
          clock_timestamp()
        );
        RETURN NULL;
      END;
      $function$;
      REVOKE ALL ON FUNCTION idle_purity_certification.record_row_write() FROM PUBLIC;
    `);
    await client.query(`
      DO $block$
      DECLARE
        target record;
      BEGIN
        FOR target IN
          SELECT namespace.nspname AS schema_name, relation.relname AS relation_name
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE relation.relkind = 'r'
            AND namespace.nspname NOT IN (
              'pg_catalog',
              'information_schema',
              'idle_purity_certification'
            )
            AND namespace.nspname NOT LIKE 'pg_toast%'
          ORDER BY namespace.nspname, relation.relname
        LOOP
          EXECUTE format(
            'CREATE TRIGGER idle_purity_certification_row_write '
            || 'AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
            || 'FOR EACH ROW EXECUTE FUNCTION idle_purity_certification.record_row_write()',
            target.schema_name,
            target.relation_name
          );
          EXECUTE format(
            'CREATE TRIGGER idle_purity_certification_truncate '
            || 'AFTER TRUNCATE ON %I.%I '
            || 'FOR EACH STATEMENT EXECUTE FUNCTION idle_purity_certification.record_row_write()',
            target.schema_name,
            target.relation_name
          );
        END LOOP;
      END;
      $block$;
    `);
    await client.query(`
      CREATE FUNCTION idle_purity_certification.record_ddl_write()
      RETURNS event_trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS $function$
      DECLARE
        has_row_trigger boolean;
        has_truncate_trigger boolean;
        target record;
      BEGIN
        INSERT INTO idle_purity_certification.write_events (
          schema_name,
          relation_name,
          operation,
          transaction_id,
          recorded_at
        ) VALUES (
          'idle_purity_certification',
          'ddl',
          TG_TAG,
          txid_current(),
          clock_timestamp()
        );

        FOR target IN
          SELECT namespace.nspname AS schema_name, relation.relname AS relation_name,
            relation.oid AS relation_oid
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE relation.relkind = 'r'
            AND namespace.nspname NOT IN (
              'pg_catalog',
              'information_schema',
              'idle_purity_certification'
            )
            AND namespace.nspname NOT LIKE 'pg_toast%'
          ORDER BY namespace.nspname, relation.relname
        LOOP
          SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_trigger
            WHERE tgrelid = target.relation_oid
              AND tgname = 'idle_purity_certification_row_write'
          ) INTO has_row_trigger;
          IF NOT has_row_trigger THEN
            EXECUTE format(
              'CREATE TRIGGER idle_purity_certification_row_write '
              || 'AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
              || 'FOR EACH ROW EXECUTE FUNCTION idle_purity_certification.record_row_write()',
              target.schema_name,
              target.relation_name
            );
          END IF;

          SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_trigger
            WHERE tgrelid = target.relation_oid
              AND tgname = 'idle_purity_certification_truncate'
          ) INTO has_truncate_trigger;
          IF NOT has_truncate_trigger THEN
            EXECUTE format(
              'CREATE TRIGGER idle_purity_certification_truncate '
              || 'AFTER TRUNCATE ON %I.%I '
              || 'FOR EACH STATEMENT EXECUTE FUNCTION idle_purity_certification.record_row_write()',
              target.schema_name,
              target.relation_name
            );
          END IF;
        END LOOP;
      END;
      $function$;
      REVOKE ALL ON FUNCTION idle_purity_certification.record_ddl_write() FROM PUBLIC;
      CREATE EVENT TRIGGER idle_purity_certification_ddl_write
        ON ddl_command_end
        EXECUTE FUNCTION idle_purity_certification.record_ddl_write();
    `);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'PostgreSQL write-audit installation and rollback both failed',
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

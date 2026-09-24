-- 028_inventory_position_revision_stability.sql
-- Panorama acknowledges newly displayed items by assigning inventory positions.
-- That position is already present in the client SOCache, so it must not cause a
-- second full inventory publication through b2g_inventory_revision.

CREATE OR REPLACE FUNCTION advance_b2g_inventory_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_player_id UUID;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'inventory_position') =
         (to_jsonb(OLD) - 'inventory_position') THEN
    RETURN NEW;
  END IF;

  target_player_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.player_id ELSE NEW.player_id END;
  UPDATE players
  SET b2g_inventory_revision = b2g_inventory_revision + 1
  WHERE id = target_player_id;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION advance_b2g_inventory_revision() IS
  'Advances content revisions while excluding client-originated inventory-position-only acknowledgements.';

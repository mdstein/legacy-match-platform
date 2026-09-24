-- Rolling-deployment gated by the node's inventorySyncVersion capability.
ALTER TABLE node_commands DROP CONSTRAINT node_commands_command_type_check;
ALTER TABLE node_commands ADD CONSTRAINT node_commands_command_type_check CHECK (
  command_type IN ('start', 'stop', 'prepare', 'sync-roster', 'sync-inventory',
                  'announce-drop', 'drain', 'quarantine', 'unquarantine')
);

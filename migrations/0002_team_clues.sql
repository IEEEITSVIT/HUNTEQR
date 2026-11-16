-- A clue belongs to one team (team_id set) or, for the shared treasure clue, to every team (team_id NULL).
ALTER TABLE hunt_clues ADD COLUMN team_id INTEGER;

-- Migration 003: Add speed_target column to machines table
-- Run this in the Supabase SQL Editor.

ALTER TABLE machines ADD COLUMN IF NOT EXISTS speed_target integer;

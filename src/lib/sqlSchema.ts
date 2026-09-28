export const SUPABASE_SQL_SCHEMA = `-- =========================================================
-- WORKERS COLLABORATIVE DASHBOARD - SUPABASE DATABASE SCHEMA
-- =========================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. PROFILES TABLE (Stores user role: 'admin' or 'worker')
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('admin', 'worker')),
  avatar_color TEXT DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
CREATE POLICY "Public profiles are viewable by authenticated users"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- 2. TASKS TABLE (Template definitions created by Admins)
CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'General',
  input_type TEXT NOT NULL DEFAULT 'yes_no' CHECK (input_type IN ('toggle', 'yes_no', 'status_select', 'checkbox')),
  assigned_to TEXT[] DEFAULT ARRAY['all'], -- ['all'] or array of worker emails
  days_of_week INT[] DEFAULT ARRAY[0,1,2,3,4,5,6], -- 0=Sun, 1=Mon, ..., 6=Sat
  target_time TEXT DEFAULT 'End of Day',
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Tasks Policies:
-- Admins can do everything
CREATE POLICY "Admins have full CRUD on tasks"
  ON public.tasks FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- Workers can read tasks that are active
CREATE POLICY "Workers can view active tasks"
  ON public.tasks FOR SELECT
  TO authenticated
  USING (is_active = true);

-- 3. DAILY TASK COMPLETIONS (Refreshes daily, tracks real-time progress)
CREATE TABLE IF NOT EXISTS public.daily_task_completions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  task_id UUID REFERENCES public.tasks(id) ON DELETE CASCADE NOT NULL,
  work_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'pending',
  is_completed BOOLEAN DEFAULT false,
  notes TEXT DEFAULT '',
  updated_by_email TEXT,
  updated_by_name TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, work_date)
);

ALTER TABLE public.daily_task_completions ENABLE ROW LEVEL SECURITY;

-- Real-time replication enabled for daily_task_completions
ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_task_completions;

-- Daily completions policies:
-- All authenticated users can view current completions
CREATE POLICY "Users can view daily completions"
  ON public.daily_task_completions FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated users (workers & admins) can update completions (marks done, adds notes)
CREATE POLICY "Users can update daily completions"
  ON public.daily_task_completions FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Admins can insert/delete daily completions
CREATE POLICY "Admins can insert daily completions"
  ON public.daily_task_completions FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- 4. HISTORY LOGS TABLE (Preserves past daily records)
CREATE TABLE IF NOT EXISTS public.history_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  work_date DATE NOT NULL,
  task_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  task_title TEXT NOT NULL,
  category TEXT DEFAULT 'General',
  status TEXT NOT NULL,
  is_completed BOOLEAN DEFAULT false,
  notes TEXT DEFAULT '',
  completed_by_email TEXT,
  completed_by_name TEXT,
  completed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.history_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read history logs"
  ON public.history_logs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Only admins or automated functions can insert into history"
  ON public.history_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- 5. TRIGGER FOR AUTO UPDATING TIMESTAMPS
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();

CREATE TRIGGER set_completions_updated_at
  BEFORE UPDATE ON public.daily_task_completions
  FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();

-- 6. MIDNIGHT DAILY RESET STORED PROCEDURE (Run via pg_cron or Edge Function)
CREATE OR REPLACE FUNCTION public.archive_and_reset_daily_tasks()
RETURNS VOID AS $$
DECLARE
  today DATE := CURRENT_DATE;
BEGIN
  -- 1. Archive previous day's completions into history_logs
  INSERT INTO public.history_logs (
    work_date,
    task_id,
    task_title,
    category,
    status,
    is_completed,
    notes,
    completed_by_email,
    completed_by_name,
    completed_at
  )
  SELECT 
    c.work_date,
    t.id,
    t.title,
    t.category,
    c.status,
    c.is_completed,
    c.notes,
    c.updated_by_email,
    c.updated_by_name,
    c.updated_at
  FROM public.daily_task_completions c
  JOIN public.tasks t ON c.task_id = t.id
  WHERE c.work_date < today;

  -- 2. Clear old completion entries
  DELETE FROM public.daily_task_completions WHERE work_date < today;

  -- 3. Initialize today's tasks
  INSERT INTO public.daily_task_completions (task_id, work_date, status, is_completed)
  SELECT id, today, 'pending', false
  FROM public.tasks
  WHERE is_active = true
  ON CONFLICT (task_id, work_date) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
`;

-- ===========================================================================
-- STATIC DEMO CONTENT (provider-owned)
-- Course -> Module -> Lecture -> content. Re-runnable (upsert by id).
--
-- content_type decides how the provider's player renders the item:
--   'video' | 'audio'  -> playable element; real playback telemetry available
--   'pdf'   | 'image'  -> rendered, but only presence can be measured
--
-- content_url accepts two forms:
--   '/media/…'  -> a file SELF-HOSTED by the provider from ./media. Served by
--                  this server behind a signed, short-lived URL, with HTTP
--                  Range support so players and PDF viewers can seek.
--   'https://…' -> an external URL, used for the sample videos so the
--                  catalogue is full without shipping gigabytes.
-- ===========================================================================

INSERT INTO courses (id, title, description) VALUES
  ('course-fin-101',
   'Introduction to Financial Markets',
   'A practical introduction to how financial markets work: instruments, participants, and the two dominant schools of analysis.')
ON CONFLICT (id) DO UPDATE
  SET title = EXCLUDED.title, description = EXCLUDED.description;

INSERT INTO modules (id, course_id, title, position) VALUES
  ('mod-1', 'course-fin-101', 'Module 1: Introduction',          1),
  ('mod-2', 'course-fin-101', 'Module 2: Technical Analysis',    2),
  ('mod-3', 'course-fin-101', 'Module 3: Fundamental Analysis',  3),
  ('mod-4', 'course-fin-101', 'Module 4: Course Resources',      4)
ON CONFLICT (id) DO UPDATE
  SET title = EXCLUDED.title, position = EXCLUDED.position, course_id = EXCLUDED.course_id;

INSERT INTO lectures (id, module_id, title, description, content_type, content_url, poster_url, duration_seconds, position) VALUES
  -- Self-hosted video: streamed from lti-content-provider/media by this server.
  ('lec-1-1', 'mod-1',
   'Understanding Stock Markets',
   'What a stock market actually is, why companies list, and how an order becomes a trade.',
   'video',
   '/media/understanding-stock-markets.mp4',
   NULL,
   18, 1),

  ('lec-1-2', 'mod-1',
   'Market Participants and Instruments',
   'Retail traders, institutions, market makers and regulators - and the instruments they trade.',
   'video',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ElephantsDream.jpg',
   653, 2),

  ('lec-2-1', 'mod-2',
   'Reading Candlestick Charts',
   'Open, high, low, close - and how a single candle encodes a whole session of trading.',
   'video',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerBlazes.jpg',
   15, 1),

  ('lec-2-2', 'mod-2',
   'Trends, Support and Resistance',
   'Identifying trend direction and the price levels where momentum tends to stall or reverse.',
   'video',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerEscapes.jpg',
   15, 2),

  ('lec-3-1', 'mod-3',
   'Reading Financial Statements',
   'Income statement, balance sheet and cash flow - what each one tells you about a business.',
   'video',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerFun.jpg',
   60, 1),

  ('lec-3-2', 'mod-3',
   'Valuation Ratios in Practice',
   'P/E, P/B, EV/EBITDA - how the common multiples are built and where they mislead.',
   'video',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
   'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/images/ForBiggerJoyrides.jpg',
   15, 2),

  -- Self-hosted PDF: proves the launch flow is content-type agnostic.
  ('lec-3-3', 'mod-3',
   'Financial Statements: Quick Reference (PDF)',
   'Two-page handout covering the three statements and the common valuation multiples.',
   'pdf',
   '/media/reading-financial-statements.pdf',
   NULL,
   0, 3),

  -- Module 4 exists to show that the launch flow is identical whatever the
  -- content is: a real exported report and an audio file, side by side.
  ('lec-4-1', 'mod-4',
   'Submission Status: All Batches, All Semesters',
   'Exported submission-status report, delivered as a PDF through the same LTI 1.3 launch.',
   'pdf',
   '/media/submission-status-all-batches.pdf',
   NULL,
   0, 1),

  ('lec-4-2', 'mod-4',
   'One-Minute Market Clock (audio)',
   'A one-minute ticking clock. Audio exposes a playback timeline, so this one reports real listening time.',
   'audio',
   '/media/one-minute-clock-ticking.mp3',
   NULL,
   60, 2)
ON CONFLICT (id) DO UPDATE
  SET module_id        = EXCLUDED.module_id,
      title            = EXCLUDED.title,
      description      = EXCLUDED.description,
      content_type     = EXCLUDED.content_type,
      content_url      = EXCLUDED.content_url,
      poster_url       = EXCLUDED.poster_url,
      duration_seconds = EXCLUDED.duration_seconds,
      position         = EXCLUDED.position;

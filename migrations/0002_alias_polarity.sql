-- "Does X belong on Y" and "does X NOT belong on Y" are the same question asked
-- from opposite ends. They share a row; the alias records which way round it was
-- asked so the negated wording can be shown the flipped probability.
ALTER TABLE question_aliases ADD COLUMN polarity INTEGER NOT NULL DEFAULT 1;

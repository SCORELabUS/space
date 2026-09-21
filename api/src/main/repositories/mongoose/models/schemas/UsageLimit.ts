import { Schema } from "mongoose";

const periodSchema = new Schema(
  {
    value: { type: Number, required: true, default: 1 },
    unit: {
      type: String,
      enum: ["SEC", "MIN", "HOUR", "DAY", "MONTH", "YEAR"],
      default: "MONTH",
      required: true,
    },
  },
  { _id: false }
);

const usageLimitSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    unit: { type: String },
    valueType: {
      type: String,
      enum: ["BOOLEAN", "NUMERIC"],
      required: true,
    },
    defaultValue: {
      type: Schema.Types.Mixed,
      required: true,
    },
    value: {
      type: Schema.Types.Mixed,
    },
    type: {
      type: String,
      enum: ["RENEWABLE", "NON_RENEWABLE"],
      required: true,
    },
    trackable: {
      type: Boolean,
      default: false,
    },
    period: {
      type: periodSchema,
    },
    linkedFeatures: {
      type: [String],
      default: [],
    }
  },
  { _id: false }
);


export default usageLimitSchema;
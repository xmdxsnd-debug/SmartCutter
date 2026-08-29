import { Router, type IRouter } from "express";
import healthRouter from "./health";
import smartCutterRouter from "./smartcutter";

const router: IRouter = Router();

router.use(healthRouter);
router.use(smartCutterRouter);

export default router;
